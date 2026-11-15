import type { LogFn } from "@/lib/logger";
import type { Db } from "@/server/db-types";
import {
  getAccount,
  getBusiness,
  listAccounts,
  readTokens,
  recordFailure,
  stateString,
  writeTokens,
  type AccountRow,
  type AccountStaffId,
} from "../common/account-store";
import { googleCredentials, requireEncryptionKey, type IntegrationEnv } from "../common/env";
import { AuthRevokedError, errorMessage } from "../common/errors";
import { withBackoff } from "../common/retry";
import { createGoogleCalendarPort, type CreatePortInput } from "./adapter";
import type { GoogleCalendarPort, GoogleTokens } from "./port";

export const DEFAULT_CALENDAR_ID = "primary";
export const RECONNECT_MESSAGE =
  "Google access was revoked or has expired. Reconnect Google Calendar.";

export interface GoogleDeps {
  db: Db;
  env: IntegrationEnv;
  now: () => Date;
  log: LogFn;
  /** Injected in tests. */
  createPort?: (input: CreatePortInput) => Promise<GoogleCalendarPort>;
}

export interface GoogleRuntime {
  account: AccountRow;
  calendarId: string;
  timezone: string;
  key: string;
  port: GoogleCalendarPort;
}

/** The Google state we keep in integration_account.sync_state. */
export interface GoogleSyncState {
  calendarId: string;
  /** Business-wide account only: the stylist whose diary its busy time blocks. */
  staffId?: string;
  syncToken?: string;
  /** ISO. End of the window a full sync covered. */
  windowEnd?: string;
  lastFullSyncAt?: string;
  channel?: { id: string; resourceId: string; expiration: string };
}

export function parseSyncState(account: AccountRow): GoogleSyncState {
  const raw = account.syncState;
  const channel = raw.channel as GoogleSyncState["channel"] | null | undefined;
  return {
    calendarId: stateString(raw, "calendarId") ?? DEFAULT_CALENDAR_ID,
    staffId: stateString(raw, "staffId"),
    syncToken: stateString(raw, "syncToken"),
    windowEnd: stateString(raw, "windowEnd"),
    lastFullSyncAt: stateString(raw, "lastFullSyncAt"),
    channel: channel && typeof channel === "object" ? channel : undefined,
  };
}

/**
 * Build the runtime for one account row. Null when it is not connected or holds no tokens:
 * callers skip quietly (the reconcile job catches up later).
 */
export async function buildGoogleRuntime(
  deps: GoogleDeps,
  account: AccountRow,
): Promise<GoogleRuntime | null> {
  if (account.status !== "connected") return null;

  const key = requireEncryptionKey(deps.env);
  const tokens = readTokens<GoogleTokens>(account, key);
  if (!tokens) return null;

  const { clientId, clientSecret } = googleCredentials(deps.env);
  const make = deps.createPort ?? createGoogleCalendarPort;
  const port = await make({
    clientId,
    clientSecret,
    tokens,
    onTokens: async (fresh) => {
      // Google keeps the refresh token; only overwrite fields it actually sent.
      await writeTokens(
        deps.db,
        account.id,
        {
          ...tokens,
          ...(fresh.accessToken ? { accessToken: fresh.accessToken } : {}),
          ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
          ...(fresh.expiryDate ? { expiryDate: fresh.expiryDate } : {}),
        },
        key,
      );
    },
  });

  const business = await getBusiness(deps.db);
  return {
    account,
    calendarId: parseSyncState(account).calendarId,
    timezone: business.timezone,
    key,
    port: withBackoff(port),
  };
}

/**
 * The runtime for (Google, staffId): a stylist's own calendar, or the business-wide one when
 * `staffId` is null (the default). Null when that account is not connected.
 */
export async function loadGoogleRuntime(
  deps: GoogleDeps,
  staffId: AccountStaffId = null,
): Promise<GoogleRuntime | null> {
  const account = await getAccount(deps.db, "google", staffId);
  return account ? buildGoogleRuntime(deps, account) : null;
}

/** Every connected Google account (business-wide first), each with a ready client. */
export async function loadAllGoogleRuntimes(deps: GoogleDeps): Promise<GoogleRuntime[]> {
  const runtimes: GoogleRuntime[] = [];
  for (const account of await listAccounts(deps.db, "google")) {
    const runtime = await buildGoogleRuntime(deps, account);
    if (runtime) runtimes.push(runtime);
  }
  return runtimes;
}

/**
 * Where a booking's calendar event lives: the stylist's own connected calendar when they have
 * one, else the business-wide calendar, else nowhere (null).
 */
export function pickOutboundRuntime(
  runtimes: readonly GoogleRuntime[],
  bookingStaffId: string,
): GoogleRuntime | null {
  return (
    runtimes.find((rt) => rt.account.staffId === bookingStaffId) ??
    runtimes.find((rt) => rt.account.staffId === null) ??
    null
  );
}

/**
 * Record a failure so the admin UI can show it. A revoked/expired token flips that one account
 * to status 'error' (the UI then offers "reconnect"); anything else just sets lastError.
 * Other accounts are never touched.
 */
export async function reportGoogleFailure(
  deps: GoogleDeps,
  error: unknown,
  staffId: AccountStaffId = null,
): Promise<void> {
  const fatal = error instanceof AuthRevokedError;
  await recordFailure(deps.db, "google", fatal ? RECONNECT_MESSAGE : errorMessage(error), {
    fatal,
    staffId,
  });
  deps.log({ event: "google_failure", fatal, staffId, message: errorMessage(error) });
}
