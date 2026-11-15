import { staff } from "@/db/schema";
import type { Db } from "@/server/db-types";
import {
  getAccount,
  listAccounts,
  stateString,
  type AccountRow,
  type IntegrationProviderName,
} from "./account-store";

export interface IntegrationStatus {
  provider: IntegrationProviderName;
  /** Null for the business-wide account, else the stylist whose own calendar this is. */
  staffId: string | null;
  /** connected | error | disconnected | not_set_up */
  status: "connected" | "error" | "disconnected" | "not_set_up";
  /** True when the owner has to reconnect (revoked or expired access). */
  needsReconnect: boolean;
  lastError: string | null;
  lastSyncAt: string | null;
  /** Human-readable target: the calendar id or the Xero organisation name. */
  target: string | null;
}

export interface StaffCalendarStatus extends IntegrationStatus {
  staffId: string;
  staffName: string;
}

function describe(
  provider: IntegrationProviderName,
  account: AccountRow | null,
  staffId: string | null,
): IntegrationStatus {
  if (!account) {
    return {
      provider,
      staffId,
      status: "not_set_up",
      needsReconnect: false,
      lastError: null,
      lastSyncAt: null,
      target: null,
    };
  }
  return {
    provider,
    staffId,
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

async function statusFor(
  db: Db,
  provider: IntegrationProviderName,
  staffId: string | null = null,
): Promise<IntegrationStatus> {
  return describe(provider, await getAccount(db, provider, staffId), staffId);
}

/** What the admin UI shows for the business-wide Integrations section. Never includes tokens. */
export async function getIntegrationStatuses(db: Db): Promise<IntegrationStatus[]> {
  return Promise.all([statusFor(db, "google"), statusFor(db, "xero")]);
}

/** One stylist's own Google calendar (`not_set_up` when they have not connected one). */
export async function getStaffCalendarStatus(db: Db, staffId: string): Promise<IntegrationStatus> {
  return statusFor(db, "google", staffId);
}

/**
 * Every stylist's own Google calendar that has ever been connected, for the Staff and
 * Integrations screens. Never includes tokens.
 */
export async function getStaffCalendarStatuses(db: Db): Promise<StaffCalendarStatus[]> {
  const accounts = (await listAccounts(db, "google")).filter((a) => a.staffId !== null);
  const names = new Map(
    (await db.select({ id: staff.id, name: staff.name }).from(staff)).map((s) => [s.id, s.name]),
  );
  return accounts.flatMap((account) => {
    const staffId = account.staffId;
    if (!staffId) return [];
    return [
      { ...describe("google", account, staffId), staffId, staffName: names.get(staffId) ?? "" },
    ];
  });
}
