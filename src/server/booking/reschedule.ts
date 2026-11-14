import { asc, eq } from "drizzle-orm";
import { booking, bookingService } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { localDate } from "../availability/engine";
import { loadBusy } from "../availability/loader";
import { searchAvailability } from "../availability";
import { recordAudit, type Actor } from "../audit";
import type { RescheduleInput } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import {
  BookingStateError,
  ChangeWindowError,
  SlotTakenError,
  ValidationError,
  isExclusionViolation,
} from "./errors";
import { isInsideCancelWindow } from "./policy";
import { auditActor, loadBookingForUpdate } from "./shared";

const MINUTE_MS = 60_000;

/**
 * Move a confirmed booking to a new start time, keeping its length (appointment plus buffer).
 *
 * - Clients may only reschedule outside the cancellation window (measured from the ORIGINAL start),
 *   and the new time must be a genuinely bookable slot (hours, notice, advance limits, conflicts).
 * - Staff may reschedule at any time and may move outside normal hours or notice limits; they are
 *   still blocked by other bookings and time blocks.
 */
export async function rescheduleBooking(
  db: Db,
  input: RescheduleInput,
  actor?: Actor,
): Promise<void> {
  if (Number.isNaN(input.newStart.getTime())) throw new ValidationError("Invalid new start time");
  const now = input.now ?? new Date();

  try {
    await db.transaction(async (tx) => {
      const row = await loadBookingForUpdate(tx, input.bookingId);
      if (row.status !== "confirmed") {
        throw new BookingStateError(
          `Cannot reschedule a booking that is ${row.status}`,
          row.status,
        );
      }

      const context = await getBusinessContext(tx, row.locationId);
      const { settings } = context;
      if (
        input.by === "client" &&
        isInsideCancelWindow(row.during.start, now, settings.cancelWindowHours)
      ) {
        throw new ChangeWindowError(settings.cancelWindowHours);
      }

      const lengthMs = row.during.end.getTime() - row.during.start.getTime();
      const during = { start: input.newStart, end: new Date(input.newStart.getTime() + lengthMs) };

      if (input.by === "client") {
        await requireBookableSlot(
          tx,
          row.id,
          row.staffId,
          row.locationId,
          input.newStart,
          now,
          context.timezone,
        );
      } else {
        const busy = await loadBusy(tx, [row.staffId], during, now, row.id);
        if ((busy.get(row.staffId) ?? []).length > 0) throw new SlotTakenError();
      }

      await tx.update(booking).set({ during, updatedAt: now }).where(eq(booking.id, row.id));

      await emitDomainEvent(tx, {
        type: "booking.rescheduled",
        bookingId: row.id,
        previousStart: row.during.start.toISOString(),
        notifyClient: input.notifyClient ?? true,
      });
      await recordAudit(tx, {
        actor: auditActor(input.by, actor),
        action: "booking.reschedule",
        entityType: "booking",
        entityId: row.id,
        data: {
          by: input.by,
          from: row.during.start.toISOString(),
          to: during.start.toISOString(),
          lengthMin: Math.round(lengthMs / MINUTE_MS),
        },
      });
    });
  } catch (error) {
    if (isExclusionViolation(error)) throw new SlotTakenError();
    throw error;
  }
}

/** The new start must appear in the availability engine's output for this booking's own staff and services. */
async function requireBookableSlot(
  db: Db,
  bookingId: string,
  staffId: string,
  locationId: string,
  newStart: Date,
  now: Date,
  timezone: string,
): Promise<void> {
  const services = await db
    .select({ serviceId: bookingService.serviceId })
    .from(bookingService)
    .where(eq(bookingService.bookingId, bookingId))
    .orderBy(asc(bookingService.position));
  const serviceIds = services.map((s) => s.serviceId);
  if (serviceIds.length === 0 || serviceIds.some((id) => id === null)) {
    // No service lines to derive availability from (e.g. a manually entered booking): conflicts only.
    const busy = await loadBusy(
      db,
      [staffId],
      { start: newStart, end: new Date(newStart.getTime() + MINUTE_MS) },
      now,
      bookingId,
    );
    if ((busy.get(staffId) ?? []).length > 0) throw new SlotTakenError();
    return;
  }

  const day = localDate(newStart, timezone);
  const search = await searchAvailability(
    db,
    {
      locationId,
      staffId,
      serviceIds: serviceIds.filter((id): id is string => id !== null),
      fromDate: day,
      toDate: day,
      now,
    },
    { excludeBookingId: bookingId },
  );
  if (!search.slots.some((s) => s.start.getTime() === newStart.getTime()))
    throw new SlotTakenError();
}
