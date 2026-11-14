import type { Db } from "@/server/db-types";
import { getAccount, stateString, type IntegrationProviderName } from "./account-store";

export interface IntegrationStatus {
  provider: IntegrationProviderName;
  /** connected | error | disconnected | not_set_up */
  status: "connected" | "error" | "disconnected" | "not_set_up";
  /** True when the owner has to reconnect (revoked or expired access). */
  needsReconnect: boolean;
  lastError: string | null;
  lastSyncAt: string | null;
  /** Human-readable target: the calendar id or the Xero organisation name. */
  target: string | null;
}

async function statusFor(db: Db, provider: IntegrationProviderName): Promise<IntegrationStatus> {
  const account = await getAccount(db, provider);
  if (!account) {
    return {
      provider,
      status: "not_set_up",
      needsReconnect: false,
      lastError: null,
      lastSyncAt: null,
      target: null,
    };
  }
  return {
    provider,
    status: account.status,
    needsReconnect: account.status === "error",
    lastError: account.lastError,
    lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
    target:
      provider === "google"
        ? (stateString(account.syncState, "calendarId") ?? null)
        : (stateString(account.syncState, "tenantName") ?? null),
  };
}

/** What the admin UI shows for the Integrations section. Never includes tokens. */
export async function getIntegrationStatuses(db: Db): Promise<IntegrationStatus[]> {
  return Promise.all([statusFor(db, "google"), statusFor(db, "xero")]);
}
