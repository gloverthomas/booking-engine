import { eq } from "drizzle-orm";
import { z } from "zod";
import { booking } from "@/db/schema";
import { getEnv } from "@/lib/env";
import type { Actor } from "../audit";
import type { CancelledBy } from "../contracts";
import type { Db } from "../db-types";
import { NotFoundError } from "./errors";

export type BookingRow = typeof booking.$inferSelect;

/** Optional injection point for the pieces of process config the booking module needs. */
export interface BookingOptions {
  /** Base64 HMAC key for manage-booking tokens. Defaults to ENCRYPTION_KEY from the environment. */
  encryptionKey?: string;
}

/** Resolve the token key lazily so a missing ENCRYPTION_KEY only fails the features that need it. */
export function resolveEncryptionKey(options: BookingOptions = {}): string {
  const key = options.encryptionKey ?? getEnv().ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY is not set; it is required to build manage-booking links");
  }
  return key;
}

const uuid = z.uuid();

export function isUuid(value: string): boolean {
  return uuid.safeParse(value).success;
}

/** Load a booking and lock the row for the rest of the transaction. */
export async function loadBookingForUpdate(db: Db, bookingId: string): Promise<BookingRow> {
  if (!isUuid(bookingId)) throw new NotFoundError(`Booking not found: ${bookingId}`);
  const [row] = await db.select().from(booking).where(eq(booking.id, bookingId)).for("update");
  if (!row) throw new NotFoundError(`Booking not found: ${bookingId}`);
  return row;
}

/** Who to record in the audit log. Callers that know the signed-in owner pass an explicit actor. */
export function auditActor(by: CancelledBy, actor?: Actor): Actor {
  return actor ?? (by === "client" ? "client" : "system");
}
