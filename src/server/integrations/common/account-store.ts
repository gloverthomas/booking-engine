import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { business, integrationAccount } from "@/db/schema";
import { decryptJson, encryptJson } from "@/server/crypto";
import type { Db } from "@/server/db-types";

export type IntegrationProviderName = "google" | "xero";
export type AccountRow = typeof integrationAccount.$inferSelect;

/**
 * Which account a call addresses: `null` is the business-wide account (Xero, and the owner's
 * shared Google calendar); a staff id is that stylist's own account.
 */
export type AccountStaffId = string | null;

/** Single-tenant today: the one business row. */
export async function getBusiness(db: Db): Promise<{ id: string; timezone: string }> {
  const [row] = await db
    .select({ id: business.id, timezone: business.timezone })
    .from(business)
    .limit(1);
  if (!row) throw new Error("No business row exists yet");
  return row;
}

function accountWhere(provider: IntegrationProviderName, staffId: AccountStaffId): SQL {
  const owner =
    staffId === null ? isNull(integrationAccount.staffId) : eq(integrationAccount.staffId, staffId);
  return and(eq(integrationAccount.provider, provider), owner) as SQL;
}

/** The account for (provider, staffId). `staffId` defaults to the business-wide account. */
export async function getAccount(
  db: Db,
  provider: IntegrationProviderName,
  staffId: AccountStaffId = null,
): Promise<AccountRow | null> {
  const [row] = await db
    .select()
    .from(integrationAccount)
    .where(accountWhere(provider, staffId))
    .limit(1);
  return row ?? null;
}

/** Every account of a provider: the business-wide one first, then each stylist's, oldest first. */
export async function listAccounts(
  db: Db,
  provider: IntegrationProviderName,
): Promise<AccountRow[]> {
  return db
    .select()
    .from(integrationAccount)
    .where(eq(integrationAccount.provider, provider))
    .orderBy(sql`${integrationAccount.staffId} IS NOT NULL`, asc(integrationAccount.createdAt));
}

export interface ConnectInput<T> {
  provider: IntegrationProviderName;
  /** A stylist's own account; omit (or null) for the business-wide account. */
  staffId?: AccountStaffId;
  externalAccountId: string;
  tokens: T;
  key: string;
  /** Replaces sync state wholesale on (re)connect. */
  syncState: Record<string, unknown>;
}

/** Create or replace the account row after a successful OAuth exchange. */
export async function saveConnection<T>(db: Db, input: ConnectInput<T>): Promise<AccountRow> {
  const biz = await getBusiness(db);
  const staffId = input.staffId ?? null;
  const values = {
    businessId: biz.id,
    staffId,
    provider: input.provider,
    externalAccountId: input.externalAccountId,
    encryptedTokens: encryptJson(input.tokens, input.key),
    status: "connected" as const,
    lastError: null,
    syncState: input.syncState,
  };
  // The unique indexes are partial: one business-wide account per provider, and one account per
  // stylist per provider. The conflict target has to name the one that applies.
  const [row] = await db
    .insert(integrationAccount)
    .values(values)
    .onConflictDoUpdate(
      staffId === null
        ? {
            target: [integrationAccount.businessId, integrationAccount.provider],
            targetWhere: sql`${integrationAccount.staffId} IS NULL`,
            set: values,
          }
        : {
            target: [integrationAccount.staffId, integrationAccount.provider],
            targetWhere: sql`${integrationAccount.staffId} IS NOT NULL`,
            set: values,
          },
    )
    .returning();
  return row;
}

export function readTokens<T>(account: AccountRow, key: string): T | null {
  if (!account.encryptedTokens) return null;
  return decryptJson<T>(account.encryptedTokens, key);
}

export async function writeTokens<T>(
  db: Db,
  accountId: string,
  tokens: T,
  key: string,
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ encryptedTokens: encryptJson(tokens, key) })
    .where(eq(integrationAccount.id, accountId));
}

/** Merge keys into sync_state atomically. A null value removes the key's meaning (readers treat null as unset). */
export async function patchSyncState(
  db: Db,
  accountId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ syncState: sql`${integrationAccount.syncState} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(integrationAccount.id, accountId));
}

export async function replaceSyncState(
  db: Db,
  accountId: string,
  syncState: Record<string, unknown>,
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ syncState })
    .where(eq(integrationAccount.id, accountId));
}

/**
 * `fatal` means the owner must reconnect: status flips to 'error' so the admin UI shows it.
 * Touches only the addressed account (`staffId`, default the business-wide one), never a sibling.
 */
export async function recordFailure(
  db: Db,
  provider: IntegrationProviderName,
  message: string,
  options: { fatal: boolean; staffId?: AccountStaffId },
): Promise<void> {
  await db
    .update(integrationAccount)
    .set(options.fatal ? { lastError: message, status: "error" } : { lastError: message })
    .where(accountWhere(provider, options.staffId ?? null));
}

export async function recordSuccess(
  db: Db,
  provider: IntegrationProviderName,
  now: Date,
  staffId: AccountStaffId = null,
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ lastError: null, lastSyncAt: now })
    .where(accountWhere(provider, staffId));
}

/**
 * `keepSyncState` preserves owner-chosen settings (Xero account codes) across a reconnect.
 * Touches only the addressed account.
 */
export async function markDisconnected(
  db: Db,
  provider: IntegrationProviderName,
  options: { keepSyncState?: boolean; staffId?: AccountStaffId } = {},
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({
      status: "disconnected",
      encryptedTokens: null,
      lastError: null,
      ...(options.keepSyncState ? {} : { syncState: {} }),
    })
    .where(accountWhere(provider, options.staffId ?? null));
}

/** Read a string-ish value out of sync_state, treating null/absent as undefined. */
export function stateString(state: Record<string, unknown>, key: string): string | undefined {
  const value = state[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
