import { eq } from "drizzle-orm";
import { auditLog, booking, domainEvent } from "@/db/schema";
import { confirmBooking, createHold } from "@/server/booking";
import type { CreateHoldInput, HoldResult } from "@/server/contracts";
import type { Db } from "@/server/db-types";
import { NOW, local, type World } from "../availability/setup";

export { NOW, local };

/** Base64 of 32 bytes; stands in for ENCRYPTION_KEY. */
export const KEY = Buffer.alloc(32, 7).toString("base64");
export const opts = { encryptionKey: KEY };

export const CLIENT = {
  firstName: "Alex",
  lastName: "Nguyen",
  email: "alex@example.com",
  phone: "0412 345 678",
};

/** A valid hold request for Monday 2026-11-02 10:00 local at the default world. */
export function holdInput(w: World, overrides: Partial<CreateHoldInput> = {}): CreateHoldInput {
  return {
    locationId: w.locationId,
    staffId: w.staffId,
    serviceIds: [w.haircutId],
    start: local("2026-11-02T10:00"),
    client: CLIENT,
    policyVersion: "1",
    now: NOW,
    ...overrides,
  };
}

export async function hold(
  w: World,
  overrides: Partial<CreateHoldInput> = {},
): Promise<HoldResult> {
  return createHold(w.db, holdInput(w, overrides), opts);
}

/** A confirmed booking (hold then confirm), Monday 10:00 local unless overridden. */
export async function confirmed(
  w: World,
  overrides: Partial<CreateHoldInput> = {},
): Promise<HoldResult> {
  const result = await hold(w, overrides);
  await confirmBooking(w.db, result.bookingId, overrides.now ?? NOW);
  return result;
}

export async function bookingRow(db: Db, id: string) {
  const [row] = await db.select().from(booking).where(eq(booking.id, id));
  return row;
}

export async function eventsOfType(db: Db, type: string) {
  const rows = await db.select().from(domainEvent).where(eq(domainEvent.type, type));
  return rows.map((row) => row.payload);
}

export async function auditActions(db: Db, entityId: string): Promise<string[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return rows.map((row) => row.action);
}
