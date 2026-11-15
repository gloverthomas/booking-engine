import { and, eq, inArray } from "drizzle-orm";
import { deviceToken, staff } from "@/db/schema";
import { ValidationError } from "../booking/errors";
import type { Db } from "../db-types";
import { isExpoToken } from "./expo";

/**
 * Remember this phone for this person. A token belongs to whoever signed in on the phone last, so a phone
 * handed to someone else stops notifying the previous person immediately.
 */
export async function registerDevice(
  db: Db,
  staffId: string,
  token: string,
  now: Date = new Date(),
): Promise<void> {
  if (!isExpoToken(token)) throw new ValidationError("That is not a valid push token");
  await db
    .insert(deviceToken)
    .values({ staffId, token, lastSeenAt: now })
    .onConflictDoUpdate({
      target: deviceToken.token,
      set: { staffId, lastSeenAt: now },
    });
}

/** Stop notifying this phone. Only the person it currently belongs to can remove it. */
export async function unregisterDevice(db: Db, staffId: string, token: string): Promise<void> {
  await db
    .delete(deviceToken)
    .where(and(eq(deviceToken.token, token), eq(deviceToken.staffId, staffId)));
}

/** Drop tokens Expo says no longer exist (app uninstalled, notifications off). */
export async function removeDeadTokens(db: Db, tokens: readonly string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.delete(deviceToken).where(inArray(deviceToken.token, [...tokens]));
}

/** The phones to notify for a set of people. Inactive staff are never notified. */
export async function tokensFor(db: Db, staffIds: readonly string[]): Promise<string[]> {
  if (staffIds.length === 0) return [];
  const rows = await db
    .select({ token: deviceToken.token })
    .from(deviceToken)
    .innerJoin(staff, eq(staff.id, deviceToken.staffId))
    .where(and(inArray(deviceToken.staffId, [...staffIds]), eq(staff.active, true)));
  return rows.map((r) => r.token);
}

/** Every active owner: told about every client booking, whoever it is with. */
export async function ownerIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.role, "owner"), eq(staff.active, true)));
  return rows.map((r) => r.id);
}
