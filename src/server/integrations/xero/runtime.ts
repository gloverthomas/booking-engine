import type { LogFn } from "@/lib/logger";
import type { Db } from "@/server/db-types";
import {
  getAccount,
  patchSyncState,
  readTokens,
  recordFailure,
  writeTokens,
  type AccountRow,
} from "../common/account-store";
import { requireEncryptionKey, xeroCredentials, type IntegrationEnv } from "../common/env";
import { AuthRevokedError, errorMessage, NotConnectedError } from "../common/errors";
import { withAdvisoryLock } from "../common/locks";
import { withBackoff, type BackoffOptions } from "../common/retry";
import { createXeroAuthPort, createXeroPort, type CreateXeroPortInput } from "./adapter";
import { readXeroConfig, type XeroConfig } from "./config";
import type { XeroAuthPort, XeroPort, XeroTokens } from "./port";

export const XERO_RECONNECT_MESSAGE = "Xero access was revoked or has expired. Reconnect Xero.";
const TOKEN_LOCK = "integrations:xero:token";
/** Refresh this long before the access token expires. */
const EXPIRY_SKEW_MS = 60_000;

export interface XeroDeps {
  db: Db;
  env: IntegrationEnv;
  now: () => Date;
  log: LogFn;
  /** Injected in tests. */
  createPort?: (input: CreateXeroPortInput) => Promise<XeroPort>;
  authPort?: XeroAuthPort;
  backoff?: BackoffOptions;
}

export interface XeroRuntime {
  account: AccountRow;
  tenantId: string;
  config: XeroConfig;
  port: XeroPort;
}

function authPortFor(deps: XeroDeps): XeroAuthPort {
  return deps.authPort ?? createXeroAuthPort(xeroCredentials(deps.env));
}

/**
 * A usable access token, refreshing when it is about to expire.
 *
 * Xero refresh tokens rotate and are single-use. The refresh therefore runs inside a
 * transaction holding an advisory lock, re-reads the stored token after taking the lock (another
 * process may have just refreshed), and writes the new token pair in the same transaction.
 * The new refresh token is committed before this function returns, so before anything uses it.
 */
export async function getXeroAccessToken(
  deps: XeroDeps,
  options: { force?: boolean } = {},
): Promise<{ account: AccountRow; accessToken: string }> {
  const key = requireEncryptionKey(deps.env);
  const account = await getAccount(deps.db, "xero");
  if (!account || account.status !== "connected")
    throw new NotConnectedError("Xero is not connected");
  const tokens = readTokens<XeroTokens>(account, key);
  if (!tokens) throw new NotConnectedError("Xero has no stored tokens");

  const isFresh = (t: XeroTokens): boolean =>
    !options.force && t.expiresAt - EXPIRY_SKEW_MS > deps.now().getTime();
  if (isFresh(tokens)) return { account, accessToken: tokens.accessToken };

  try {
    const outcome = await withAdvisoryLock(deps.db, TOKEN_LOCK, { wait: true }, async (tx) => {
      const latest = await getAccount(tx, "xero");
      const current = latest ? readTokens<XeroTokens>(latest, key) : null;
      if (!latest || !current) throw new NotConnectedError("Xero is not connected");
      if (isFresh(current)) return { account: latest, accessToken: current.accessToken };

      const next = await authPortFor(deps).refresh(current.refreshToken);
      await writeTokens(tx, latest.id, next, key);
      await patchSyncState(tx, latest.id, { lastTokenRefreshAt: deps.now().toISOString() });
      return { account: latest, accessToken: next.accessToken };
    });
    if (!outcome.acquired) throw new Error("unreachable: blocking lock always acquires");
    return outcome.value;
  } catch (error) {
    if (error instanceof AuthRevokedError) {
      await recordFailure(deps.db, "xero", XERO_RECONNECT_MESSAGE, { fatal: true });
      deps.log({ event: "xero_auth_revoked", message: errorMessage(error) });
    }
    throw error;
  }
}

/** Throws NotConnectedError when Xero is not connected; callers decide whether that is fatal. */
export async function loadXeroRuntime(deps: XeroDeps): Promise<XeroRuntime> {
  const { account, accessToken } = await getXeroAccessToken(deps);
  if (!account.externalAccountId) throw new NotConnectedError("Xero has no organisation selected");
  const make = deps.createPort ?? createXeroPort;
  const port = await make({ tenantId: account.externalAccountId, accessToken });
  return {
    account,
    tenantId: account.externalAccountId,
    config: readXeroConfig(account),
    port: withBackoff(port, deps.backoff),
  };
}
