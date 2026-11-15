import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { staff, timeBlock } from "@/db/schema";
import type { Permission } from "@/server/auth/permissions";
import {
  getAccount,
  markDisconnected,
  saveConnection,
  type AccountRow,
} from "../common/account-store";
import {
  googleCredentials,
  isHttps,
  redirectUri,
  requireAppUrl,
  requireEncryptionKey,
} from "../common/env";
import { errorMessage } from "../common/errors";
import {
  clearOAuthCookie,
  jsonResponse,
  redirectResponse,
  setOAuthCookie,
  settingsRedirect,
} from "../common/http";
import {
  beginOAuth,
  completeOAuth,
  oauthCookieName,
  OAuthStateError,
  readCookie,
} from "../common/oauth-state";
import { mayManageCalendar, permissionToReach, type GoogleAccessSession } from "./access";
import { createGoogleAuthPort } from "./adapter";
import {
  ensureWatchChannel,
  handleGoogleWebhook,
  readWebhookHeaders,
  stopWatchChannel,
} from "./channel";
import { hasOwnConnectedCalendar, resolveStaffId, syncGoogleCalendar } from "./inbound";
import type { GoogleAuthPort, GoogleTokens } from "./port";
import { DEFAULT_CALENDAR_ID, parseSyncState, type GoogleDeps } from "./runtime";

export interface GoogleRouteDeps extends GoogleDeps {
  /** `requireAccess` from src/server/auth/access.ts: redirects when signed out, throws when denied. */
  requireAccess: (permission: Permission) => Promise<GoogleAccessSession>;
  /** Injected in tests; defaults to the googleapis-backed port. */
  authPort?: GoogleAuthPort;
  /** Run work after the response is sent (Next's `after`). */
  runAfter: (task: () => Promise<void>) => void;
}

const calendarIdSchema = z.string().trim().min(1).max(256).default(DEFAULT_CALENDAR_ID);
const staffIdSchema = z.uuid();

function authPortFor(deps: GoogleRouteDeps): GoogleAuthPort {
  return deps.authPort ?? createGoogleAuthPort(googleCredentials(deps.env));
}

type TargetResult = { ok: true; staffId: string | null } | { ok: false; response: Response };

/**
 * Reads `?staffId=` (absent = the business-wide calendar), checks the caller may manage that
 * calendar and that the stylist exists. The permission check runs before anything is validated.
 */
async function resolveTarget(request: Request, deps: GoogleRouteDeps): Promise<TargetResult> {
  const raw = new URL(request.url).searchParams.get("staffId");
  const session = await deps.requireAccess(permissionToReach(raw));
  if (raw === null) {
    return mayManageCalendar(session, null)
      ? { ok: true, staffId: null }
      : { ok: false, response: jsonResponse({ error: "Not allowed" }, 403) };
  }
  const parsed = staffIdSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, response: jsonResponse({ error: "Invalid staffId" }, 400) };
  if (!mayManageCalendar(session, parsed.data)) {
    return { ok: false, response: jsonResponse({ error: "Not allowed" }, 403) };
  }
  const [row] = await deps.db.select({ id: staff.id }).from(staff).where(eq(staff.id, parsed.data));
  if (!row) return { ok: false, response: jsonResponse({ error: "Unknown stylist" }, 404) };
  return { ok: true, staffId: parsed.data };
}

/** GET /api/integrations/google/connect[?calendarId=...][&staffId=...] */
export async function googleConnect(request: Request, deps: GoogleRouteDeps): Promise<Response> {
  const target = await resolveTarget(request, deps);
  if (!target.ok) return target.response;
  const key = requireEncryptionKey(deps.env);
  const appUrl = requireAppUrl(deps.env);

  const requested = new URL(request.url).searchParams.get("calendarId") ?? undefined;
  const parsed = calendarIdSchema.safeParse(requested);
  if (!parsed.success) return jsonResponse({ error: "Invalid calendarId" }, 400);

  // The stylist is bound into the encrypted OAuth cookie: the callback trusts only that, never a
  // query parameter, so a callback can't be pointed at someone else's calendar.
  const begun = beginOAuth({
    provider: "google",
    key,
    now: deps.now(),
    extra: {
      calendarId: parsed.data,
      ...(target.staffId ? { staffId: target.staffId } : {}),
    },
  });
  const url = await authPortFor(deps).buildAuthUrl({
    state: begun.state,
    codeChallenge: begun.codeChallenge,
    redirectUri: redirectUri(deps.env, "google"),
  });
  return redirectResponse(url, [setOAuthCookie("google", begun.cookieValue, isHttps(appUrl))]);
}

/** GET /api/integrations/google/callback */
export async function googleCallback(request: Request, deps: GoogleRouteDeps): Promise<Response> {
  // Anyone with a diary may be mid-connect; the exact right is checked against the bound stylist.
  const session = await deps.requireAccess("calendar.viewOwn");
  const key = requireEncryptionKey(deps.env);
  const appUrl = requireAppUrl(deps.env);
  const secure = isHttps(appUrl);
  const clear = [clearOAuthCookie("google", secure)];
  const fail = (message: string) =>
    settingsRedirect(appUrl, "google", { ok: false, message }, clear);

  const params = new URL(request.url).searchParams;
  if (params.get("error")) return fail("Google sign-in was cancelled or denied.");

  try {
    const transaction = completeOAuth({
      provider: "google",
      key,
      now: deps.now(),
      cookieValue: readCookie(request.headers.get("cookie"), oauthCookieName("google")),
      stateParam: params.get("state"),
    });
    const staffId = transaction.extra.staffId ?? null;
    if (!mayManageCalendar(session, staffId)) {
      return fail("You do not have permission to connect this calendar.");
    }
    const code = params.get("code");
    if (!code) return fail("Google did not return an authorisation code.");

    const tokens: GoogleTokens = await authPortFor(deps).exchangeCode({
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri: redirectUri(deps.env, "google"),
    });
    if (!tokens.refreshToken) {
      return fail(
        "Google did not issue a refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
      );
    }

    const calendarId = transaction.extra.calendarId ?? DEFAULT_CALENDAR_ID;
    await saveConnection(deps.db, {
      provider: "google",
      staffId,
      externalAccountId: calendarId,
      tokens,
      key,
      syncState: { calendarId },
    });
    deps.runAfter(async () => {
      try {
        await syncGoogleCalendar(deps, { forceFull: true, staffId });
        await ensureWatchChannel(deps, { staffId });
      } catch (error) {
        deps.log({ event: "google_initial_sync_failed", staffId, message: errorMessage(error) });
      }
    });
    return settingsRedirect(appUrl, "google", { ok: true }, clear);
  } catch (error) {
    if (error instanceof OAuthStateError) return fail(error.message);
    deps.log({ event: "google_callback_failed", message: errorMessage(error) });
    return fail("Could not complete the Google connection. Try again.");
  }
}

/** Remove the imported busy time that belonged to this account, and nobody else's. */
async function removeImportedBlocks(deps: GoogleRouteDeps, account: AccountRow): Promise<void> {
  const staffId = await resolveStaffId(deps.db, account, parseSyncState(account).staffId);
  if (!staffId) return;
  // A business-wide calendar was not feeding this stylist if they have their own.
  if (account.staffId === null && (await hasOwnConnectedCalendar(deps.db, staffId))) return;
  await deps.db
    .delete(timeBlock)
    .where(and(eq(timeBlock.staffId, staffId), eq(timeBlock.source, "google")));
}

/** POST /api/integrations/google/disconnect[?staffId=...] */
export async function googleDisconnect(request: Request, deps: GoogleRouteDeps): Promise<Response> {
  const target = await resolveTarget(request, deps);
  if (!target.ok) return target.response;
  const account = await getAccount(deps.db, "google", target.staffId);
  if (!account) return jsonResponse({ ok: true });

  await stopWatchChannel(deps, target.staffId);
  // Imported busy time must not keep blocking availability once the link is gone.
  await removeImportedBlocks(deps, account);
  await markDisconnected(deps.db, "google", { staffId: target.staffId });
  return jsonResponse({ ok: true });
}

/**
 * POST /api/integrations/google/webhook. No session: Google calls this, and the channel token
 * is the credential. The sync (of the account that owns the channel) runs after the 200 so
 * Google is never kept waiting.
 */
export async function googleWebhook(request: Request, deps: GoogleRouteDeps): Promise<Response> {
  const outcome = await handleGoogleWebhook(
    {
      ...deps,
      kickSync: (account) =>
        deps.runAfter(async () => {
          try {
            await syncGoogleCalendar(deps, { staffId: account.staffId });
          } catch (error) {
            deps.log({ event: "google_webhook_sync_failed", message: errorMessage(error) });
          }
        }),
    },
    readWebhookHeaders(request.headers),
  );
  return new Response(null, { status: outcome.status });
}
