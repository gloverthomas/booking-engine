import { and, eq, isNotNull, lte } from "drizzle-orm";
import { booking } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { recordAudit, type Actor } from "../audit";
import type { CancelOutcome } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { BookingStateError, HoldExpiredError } from "./errors";
import { lateFee } from "./policy";
import { loadBookingForUpdate } from "./shared";

/**
 * Mark pending bookings whose hold has lapsed as expired (frees the slot for the exclusion
 * constraint). Returns the expired booking ids.
 */
export async function expireLapsedHolds(db: Db, now: Date): Promise<string[]> {
  const expired = await db
    .update(booking)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(booking.status, "pending_payment"),
        isNotNull(booking.holdExpiresAt),
        lte(booking.holdExpiresAt, now),
      ),
    )
    .returning({ id: booking.id });
  for (const { id } of expired) {
    await recordAudit(db, {
      actor: "system",
      action: "booking.expire",
      entityType: "booking",
      entityId: id,
    });
  }
  return expired.map((row) => row.id);
}

/** Expire pending bookings whose hold has lapsed. Returns how many were expired. */
export async function expireHolds(db: Db, now: Date = new Date()): Promise<number> {
  return db.transaction(async (tx) => (await expireLapsedHolds(tx, now)).length);
}

/**
 * Called by payments once the deposit has succeeded (or immediately when depositCents is 0).
 * Idempotent: confirming an already confirmed booking is a no-op.
 */
export async function confirmBooking(
  db: Db,
  bookingId: string,
  now: Date = new Date(),
  options: { notifyClient?: boolean } = {},
) {
  await db.transaction(async (tx) => {
    const row = await loadBookingForUpdate(tx, bookingId);
    if (row.status === "confirmed") return;
    if (row.status === "expired") throw new HoldExpiredError(row.status);
    if (row.status !== "pending_payment") {
      throw new BookingStateError(`Cannot confirm a booking that is ${row.status}`, row.status);
    }
    if (row.holdExpiresAt && row.holdExpiresAt.getTime() <= now.getTime()) {
      throw new HoldExpiredError(row.status);
    }

    await tx
      .update(booking)
      .set({ status: "confirmed", holdExpiresAt: null, updatedAt: now })
      .where(eq(booking.id, bookingId));
    await emitDomainEvent(tx, {
      type: "booking.confirmed",
      bookingId,
      notifyClient: options.notifyClient ?? true,
    });
    await recordAudit(tx, {
      actor: "system",
      action: "booking.confirm",
      entityType: "booking",
      entityId: bookingId,
    });
  });
}

/** Staff marks a confirmed booking as finished. Idempotent for an already completed booking. */
export async function completeBooking(
  db: Db,
  bookingId: string,
  now: Date = new Date(),
  actor: Actor = "system",
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await loadBookingForUpdate(tx, bookingId);
    if (row.status === "completed") return;
    if (row.status !== "confirmed") {
      throw new BookingStateError(`Cannot complete a booking that is ${row.status}`, row.status);
    }
    await tx
      .update(booking)
      .set({ status: "completed", updatedAt: now })
      .where(eq(booking.id, bookingId));
    await emitDomainEvent(tx, { type: "booking.completed", bookingId });
    await recordAudit(tx, {
      actor,
      action: "booking.complete",
      entityType: "booking",
      entityId: bookingId,
    });
  });
}

/**
 * The client did not turn up: the deposit is kept and the optional extra fee (extraFeePct of the
 * total) is charged by the payments consumer reacting to booking.no_show.
 *
 * The contract's CancelOutcome.status has no "no_show" member, so the outcome reports
 * "late_cancelled"; the booking row itself is stored as no_show.
 */
export async function markNoShow(
  db: Db,
  bookingId: string,
  now: Date = new Date(),
  actor: Actor = "system",
): Promise<CancelOutcome> {
  return db.transaction(async (tx) => {
    const row = await loadBookingForUpdate(tx, bookingId);
    if (row.status !== "confirmed") {
      throw new BookingStateError(`Cannot mark a ${row.status} booking as a no-show`, row.status);
    }
    if (row.during.start.getTime() > now.getTime()) {
      throw new BookingStateError("A booking can only be marked no-show after its start time");
    }

    const { settings } = await getBusinessContext(tx, row.locationId);
    const feeCents = lateFee(row.totalCents, settings.extraFeePct);

    await tx
      .update(booking)
      .set({ status: "no_show", updatedAt: now })
      .where(eq(booking.id, bookingId));
    await emitDomainEvent(tx, { type: "booking.no_show", bookingId, feeCents });
    await recordAudit(tx, {
      actor,
      action: "booking.no_show",
      entityType: "booking",
      entityId: bookingId,
      data: { feeCents },
    });
    return { bookingId, status: "no_show", depositAction: "keep", feeCents };
  });
}
