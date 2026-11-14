import { eq } from "drizzle-orm";
import { z } from "zod";
import { timeBlock } from "@/db/schema";
import { getAccount, markDisconnected, saveConnection } from "../common/account-store";
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
import { createGoogleAuthPort } from "./adapter";
import {
  ensureWatchChannel,
  handleGoogleWebhook,
  readWebhookHeaders,
  stopWatchChannel,
} from "./channel";
import { DEFAULT_CALENDAR_ID, type GoogleDeps } from "./runtime";
import type { GoogleAuthPort, GoogleTokens } from "./port";
import { syncGoogleCalendar } from "./inbound";

export interface GoogleRouteDeps extends GoogleDeps {
  requireOwner: () => Promise<unknown>;
  /** Injected in tests; defaults to the googleapis-backed port. */
  authPort?: GoogleAuthPort;
  /** Run work after the response is sent (Next's `after`). */
  runAfter: (task: () => Promise<void>) => void;
}

const calendarIdSchema = z.string().trim().min(1).max(256).default(DEFAULT_CALENDAR_ID);

function authPortFor(deps: GoogleRouteDeps): GoogleAuthPort {
  return deps.authPort ?? createGoogleAuthPort(googleCredentials(deps.env));
}

/** GET /api/integrations/google/connect[?calendarId=...] */
export async function googleConnect(request: Request, deps: GoogleRouteDeps): Promise<Response> {
  await deps.requireOwner();
  const key = requireEncryptionKey(deps.env);
  const appUrl = requireAppUrl(deps.env);

  const requested = new URL(request.url).searchParams.get("calendarId") ?? undefined;
  const parsed = calendarIdSchema.safeParse(requested);
  if (!parsed.success) return jsonResponse({ error: "Invalid calendarId" }, 400);

  const begun = beginOAuth({
    provider: "google",
    key,
    now: deps.now(),
    extra: { calendarId: parsed.data },
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
  await deps.requireOwner();
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
      externalAccountId: calendarId,
      tokens,
      key,
      syncState: { calendarId },
    });
    deps.runAfter(async () => {
      try {
        await syncGoogleCalendar(deps, { forceFull: true });
        await ensureWatchChannel(deps);
      } catch (error) {
        deps.log({ event: "google_initial_sync_failed", message: errorMessage(error) });
      }
    });
    return settingsRedirect(appUrl, "google", { ok: true }, clear);
  } catch (error) {
    if (error instanceof OAuthStateError) return fail(error.message);
    deps.log({ event: "google_callback_failed", message: errorMessage(error) });
    return fail("Could not complete the Google connection. Try again.");
  }
}

/** POST /api/integrations/google/disconnect */
export async function googleDisconnect(
  _request: Request,
  deps: GoogleRouteDeps,
): Promise<Response> {
  await deps.requireOwner();
  const account = await getAccount(deps.db, "google");
  if (!account) return jsonResponse({ ok: true });

  await stopWatchChannel(deps);
  // Imported busy time must not keep blocking availability once the link is gone.
  await deps.db.delete(timeBlock).where(eq(timeBlock.source, "google"));
  await markDisconnected(deps.db, "google");
  return jsonResponse({ ok: true });
}

/**
 * POST /api/integrations/google/webhook. No owner session: Google calls this, and the channel
 * token is the credential. The sync runs after the 200 so Google is never kept waiting.
 */
export async function googleWebhook(request: Request, deps: GoogleRouteDeps): Promise<Response> {
  const outcome = await handleGoogleWebhook(
    {
      ...deps,
      kickSync: () =>
        deps.runAfter(async () => {
          try {
            await syncGoogleCalendar(deps);
          } catch (error) {
            deps.log({ event: "google_webhook_sync_failed", message: errorMessage(error) });
          }
        }),
    },
    readWebhookHeaders(request.headers),
  );
  return new Response(null, { status: outcome.status });
}
