import { z } from "zod";
import {
  getAccount,
  markDisconnected,
  patchSyncState,
  saveConnection,
} from "../common/account-store";
import {
  isHttps,
  redirectUri,
  requireAppUrl,
  requireEncryptionKey,
  xeroCredentials,
} from "../common/env";
import { errorMessage, NotConnectedError } from "../common/errors";
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
import { createXeroAuthPort } from "./adapter";
import {
  readXeroConfig,
  XERO_CONFIG_KEYS,
  xeroConfigPatchSchema,
  xeroConfigSchema,
} from "./config";
import type { XeroAuthPort } from "./port";
import { runXeroReconcile } from "./jobs";
import { loadXeroRuntime, type XeroDeps } from "./runtime";

export interface XeroRouteDeps extends XeroDeps {
  requireOwner: () => Promise<unknown>;
  /** Run work after the response is sent (Next's `after`). */
  runAfter: (task: () => Promise<void>) => void;
}

function authPortFor(deps: XeroRouteDeps): XeroAuthPort {
  return deps.authPort ?? createXeroAuthPort(xeroCredentials(deps.env));
}

/** GET /api/integrations/xero/connect */
export async function xeroConnect(_request: Request, deps: XeroRouteDeps): Promise<Response> {
  await deps.requireOwner();
  const key = requireEncryptionKey(deps.env);
  const appUrl = requireAppUrl(deps.env);

  // Xero's web-app flow authenticates with the client secret; `state` is the CSRF check.
  const begun = beginOAuth({ provider: "xero", key, now: deps.now() });
  const url = await authPortFor(deps).buildConsentUrl({
    state: begun.state,
    redirectUri: redirectUri(deps.env, "xero"),
  });
  return redirectResponse(url, [setOAuthCookie("xero", begun.cookieValue, isHttps(appUrl))]);
}

/** GET /api/integrations/xero/callback */
export async function xeroCallback(request: Request, deps: XeroRouteDeps): Promise<Response> {
  await deps.requireOwner();
  const key = requireEncryptionKey(deps.env);
  const appUrl = requireAppUrl(deps.env);
  const clear = [clearOAuthCookie("xero", isHttps(appUrl))];
  const fail = (message: string) => settingsRedirect(appUrl, "xero", { ok: false, message }, clear);

  const url = new URL(request.url);
  if (url.searchParams.get("error")) return fail("Xero sign-in was cancelled or denied.");

  try {
    const transaction = completeOAuth({
      provider: "xero",
      key,
      now: deps.now(),
      cookieValue: readCookie(request.headers.get("cookie"), oauthCookieName("xero")),
      stateParam: url.searchParams.get("state"),
    });
    const target = redirectUri(deps.env, "xero");
    const { tokens, tenants } = await authPortFor(deps).exchangeCallback({
      // Rebuilt on the public URL: behind a proxy request.url may carry an internal host.
      callbackUrl: `${target}${url.search}`,
      state: transaction.state,
      redirectUri: target,
    });
    const tenant = tenants[0];
    if (!tenant) return fail("No Xero organisation was authorised. Choose one and try again.");

    // Keep the owner's accounting choices across a reconnect.
    const previous = await getAccount(deps.db, "xero");
    const keep = Object.fromEntries(
      XERO_CONFIG_KEYS.flatMap((k) =>
        previous?.syncState[k] === undefined ? [] : [[k, previous.syncState[k]]],
      ),
    );
    await saveConnection(deps.db, {
      provider: "xero",
      externalAccountId: tenant.tenantId,
      tokens,
      key,
      syncState: {
        ...keep,
        tenantName: tenant.tenantName,
        lastTokenRefreshAt: deps.now().toISOString(),
      },
    });
    // Bookings made while Xero was disconnected get invoiced now.
    deps.runAfter(async () => {
      try {
        await runXeroReconcile(deps);
      } catch (error) {
        deps.log({ event: "xero_connect_reconcile_failed", message: errorMessage(error) });
      }
    });
    return settingsRedirect(appUrl, "xero", { ok: true }, clear);
  } catch (error) {
    if (error instanceof OAuthStateError) return fail(error.message);
    deps.log({ event: "xero_callback_failed", message: errorMessage(error) });
    return fail("Could not complete the Xero connection. Try again.");
  }
}

/** POST /api/integrations/xero/disconnect */
export async function xeroDisconnect(_request: Request, deps: XeroRouteDeps): Promise<Response> {
  await deps.requireOwner();
  await markDisconnected(deps.db, "xero", { keepSyncState: true });
  return jsonResponse({ ok: true });
}

/** GET /api/integrations/xero/config */
export async function xeroGetConfig(_request: Request, deps: XeroRouteDeps): Promise<Response> {
  await deps.requireOwner();
  const account = await getAccount(deps.db, "xero");
  return jsonResponse({ config: account ? readXeroConfig(account) : xeroConfigSchema.parse({}) });
}

/** PATCH /api/integrations/xero/config: validated partial update of the accounting settings. */
export async function xeroUpdateConfig(request: Request, deps: XeroRouteDeps): Promise<Response> {
  await deps.requireOwner();
  const account = await getAccount(deps.db, "xero");
  if (!account) return jsonResponse({ error: "Xero is not connected" }, 409);

  const body: unknown = await request.json().catch(() => null);
  const parsed = xeroConfigPatchSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid settings", issues: z.treeifyError(parsed.error) }, 400);
  }
  await patchSyncState(deps.db, account.id, parsed.data);
  const updated = await getAccount(deps.db, "xero");
  return jsonResponse({ config: updated ? readXeroConfig(updated) : null });
}

/** GET /api/integrations/xero/accounts: the chart of accounts, for choosing account codes. */
export async function xeroListAccounts(_request: Request, deps: XeroRouteDeps): Promise<Response> {
  await deps.requireOwner();
  try {
    const runtime = await loadXeroRuntime(deps);
    const accounts = (await runtime.port.listAccounts()).filter((a) => a.status === "ACTIVE");
    return jsonResponse({ accounts });
  } catch (error) {
    if (error instanceof NotConnectedError) return jsonResponse({ error: error.message }, 409);
    deps.log({ event: "xero_accounts_failed", message: errorMessage(error) });
    return jsonResponse({ error: "Could not load Xero accounts" }, 502);
  }
}
