import { eq } from "drizzle-orm";
import { auditLog, domainEvent, waitlistEntry, waitlistOffer } from "@/db/schema";
import { confirmBooking, createHold } from "@/server/booking";
import type { ClientInput, HoldResult, WaitlistJoinInput } from "@/server/contracts";
import type { Db } from "@/server/db-types";
import { createWaitlistOffer, joinWaitlist } from "@/server/waitlist";
import { makeManageToken } from "@/server/manage-token";
import { NOW, local, type World } from "../availability/setup";

export { NOW, local };

/** Base64 of 32 bytes; stands in for ENCRYPTION_KEY. */
export const KEY = Buffer.alloc(32, 9).toString("base64");
export const opts = { encryptionKey: KEY };

export const MONDAY_10 = "2026-11-02T10:00";

export function person(n: number): ClientInput {
  return {
    firstName: `Person${n}`,
    lastName: "Waiting",
    email: `person${n}@example.com`,
    phone: `04${String(10000000 + n)}`,
  };
}

export function joinInput(w: World, overrides: Partial<WaitlistJoinInput> = {}): WaitlistJoinInput {
  return {
    client: person(1),
    locationId: w.locationId,
    serviceIds: [w.haircutId],
    earliestDate: "2026-11-02",
    latestDate: "2026-11-06",
    now: NOW,
    ...overrides,
  };
}

export async function join(w: World, overrides: Partial<WaitlistJoinInput> = {}) {
  return joinWaitlist(w.db, joinInput(w, overrides));
}

/** A confirmed booking by someone else on Monday at `at` (local), 45 min. */
export async function bookedSlot(
  w: World,
  at = MONDAY_10,
  client: ClientInput = { firstName: "Booker", lastName: "One", email: "b@example.com", phone: "0499000111" },
): Promise<HoldResult> {
  const hold = await createHold(
    w.db,
    {
      locationId: w.locationId,
      staffId: w.staffId,
      serviceIds: [w.haircutId],
      start: local(at),
      client,
      policyVersion: "1",
      now: NOW,
    },
    opts,
  );
  await confirmBooking(w.db, hold.bookingId, NOW);
  return hold;
}

export async function offerTo(w: World, entryId: string, at = MONDAY_10, offeredBy = "auto") {
  const start = local(at);
  return createWaitlistOffer(w.db, {
    entryId,
    staffId: w.staffId,
    during: { start, end: new Date(start.getTime() + 45 * 60_000) },
    offeredBy,
    now: NOW,
  });
}

export const tokenFor = (id: string) => makeManageToken(id, KEY);

export async function entryRow(db: Db, id: string) {
  const [row] = await db.select().from(waitlistEntry).where(eq(waitlistEntry.id, id));
  return row;
}

export async function offerRow(db: Db, id: string) {
  const [row] = await db.select().from(waitlistOffer).where(eq(waitlistOffer.id, id));
  return row;
}

export async function events(db: Db, type: string) {
  const rows = await db.select().from(domainEvent).where(eq(domainEvent.type, type));
  return rows.map((r) => r.payload);
}

export async function audits(db: Db, entityId: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return rows.map((r) => ({ action: r.action, actor: r.actor }));
}
