import { eq, sql } from "drizzle-orm";
import { business, integrationAccount } from "@/db/schema";
import { decryptJson, encryptJson } from "@/server/crypto";
import type { Db } from "@/server/db-types";

export type IntegrationProviderName = "google" | "xero";
export type AccountRow = typeof integrationAccount.$inferSelect;

/** Single-tenant today: the one business row. */
export async function getBusiness(db: Db): Promise<{ id: string; timezone: string }> {
  const [row] = await db
    .select({ id: business.id, timezone: business.timezone })
    .from(business)
    .limit(1);
  if (!row) throw new Error("No business row exists yet");
  return row;
}

export async function getAccount(
  db: Db,
  provider: IntegrationProviderName,
): Promise<AccountRow | null> {
  const [row] = await db
    .select()
    .from(integrationAccount)
    .where(eq(integrationAccount.provider, provider))
    .limit(1);
  return row ?? null;
}

export interface ConnectInput<T> {
  provider: IntegrationProviderName;
  externalAccountId: string;
  tokens: T;
  key: string;
  /** Replaces sync state wholesale on (re)connect. */
  syncState: Record<string, unknown>;
}

/** Create or replace the account row after a successful OAuth exchange. */
export async function saveConnection<T>(db: Db, input: ConnectInput<T>): Promise<AccountRow> {
  const biz = await getBusiness(db);
  const values = {
    businessId: biz.id,
    provider: input.provider,
    externalAccountId: input.externalAccountId,
    encryptedTokens: encryptJson(input.tokens, input.key),
    status: "connected" as const,
    lastError: null,
    syncState: input.syncState,
  };
  const [row] = await db
    .insert(integrationAccount)
    .values(values)
    .onConflictDoUpdate({
      target: [integrationAccount.businessId, integrationAccount.provider],
      set: values,
    })
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

/** `fatal` means the owner must reconnect: status flips to 'error' so the admin UI shows it. */
export async function recordFailure(
  db: Db,
  provider: IntegrationProviderName,
  message: string,
  options: { fatal: boolean },
): Promise<void> {
  await db
    .update(integrationAccount)
    .set(options.fatal ? { lastError: message, status: "error" } : { lastError: message })
    .where(eq(integrationAccount.provider, provider));
}

export async function recordSuccess(
  db: Db,
  provider: IntegrationProviderName,
  now: Date,
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ lastError: null, lastSyncAt: now })
    .where(eq(integrationAccount.provider, provider));
}

/** `keepSyncState` preserves owner-chosen settings (Xero account codes) across a reconnect. */
export async function markDisconnected(
  db: Db,
  provider: IntegrationProviderName,
  options: { keepSyncState?: boolean } = {},
): Promise<void> {
  await db
    .update(integrationAccount)
    .set({
      status: "disconnected",
      encryptedTokens: null,
      lastError: null,
      ...(options.keepSyncState ? {} : { syncState: {} }),
    })
    .where(eq(integrationAccount.provider, provider));
}

/** Read a string-ish value out of sync_state, treating null/absent as undefined. */
export function stateString(state: Record<string, unknown>, key: string): string | undefined {
  const value = state[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
