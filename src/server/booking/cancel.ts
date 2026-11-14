import { eq } from "drizzle-orm";
import { booking } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { recordAudit, type Actor } from "../audit";
import type { CancelInput, CancelOutcome } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { BookingStateError } from "./errors";
import { decideCancellation } from "./policy";
import { auditActor, loadBookingForUpdate } from "./shared";

/**
 * Cancel a pending or confirmed booking under the cancellation policy. This module only decides
 * and records; the refund or fee is performed by the payments consumer reacting to booking.cancelled.
 */
export async function cancelBooking(
  db: Db,
  input: CancelInput,
  actor?: Actor,
): Promise<CancelOutcome> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const row = await loadBookingForUpdate(tx, input.bookingId);
    if (row.status !== "pending_payment" && row.status !== "confirmed") {
      throw new BookingStateError(`Cannot cancel a booking that is ${row.status}`, row.status);
    }

    const { settings } = await getBusinessContext(tx, row.locationId);
    const decision = decideCancellation({
      bookingStatus: row.status,
      by: input.by,
      start: row.during.start,
      now,
      totalCents: row.totalCents,
      settings,
      forceRefund: input.forceRefund,
    });

    await tx
      .update(booking)
      .set({
        status: decision.status,
        cancelledAt: now,
        cancelReason: input.reason,
        holdExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(booking.id, row.id));

    await emitDomainEvent(tx, {
      type: "booking.cancelled",
      bookingId: row.id,
      by: input.by,
      depositAction: decision.depositAction,
      feeCents: decision.feeCents,
    });
    await recordAudit(tx, {
      actor: auditActor(input.by, actor),
      action: "booking.cancel",
      entityType: "booking",
      entityId: row.id,
      data: {
        by: input.by,
        status: decision.status,
        depositAction: decision.depositAction,
        feeCents: decision.feeCents,
        reason: input.reason ?? null,
        forceRefund: input.forceRefund ?? false,
      },
    });

    return { bookingId: row.id, ...decision };
  });
}
