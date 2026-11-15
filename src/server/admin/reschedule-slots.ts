import { asc, eq } from "drizzle-orm";
import { booking, bookingService } from "@/db/schema";
import { getAvailableSlots, type PricedSlot } from "../availability";
import { assertCan } from "./access";
import { loadAccessibleBooking, type CommandContext } from "./commands";
import { AdminError } from "./errors";

export interface RescheduleSlots {
  /** Where the appointment is now, so the app can show "keep this time". */
  current: { start: string; end: string };
  slots: PricedSlot[];
  /**
   * Set when times cannot be suggested: the appointment has a service that is not in the catalogue (an
   * import, or a service since deleted), so there is nothing to price or time it against.
   */
  reason: "services_not_in_catalogue" | null;
}

/**
 * The times this appointment could move to: same stylist, same place, same services, with the
 * appointment's own current slot treated as free so it can be nudged by a few minutes. The permission and
 * ownership rule is the one `rescheduleStaffBooking` applies, so a stylist only sees their own.
 */
export async function rescheduleSlots(
  ctx: CommandContext,
  input: { bookingId: string; fromDate: string; toDate: string },
): Promise<RescheduleSlots> {
  assertCan(ctx.access, "booking.edit");
  const owned = await loadAccessibleBooking(ctx, input.bookingId);
  if (owned.status !== "confirmed") {
    throw new AdminError("Only a confirmed appointment can be moved");
  }

  const [row] = await ctx.db
    .select({ locationId: booking.locationId, during: booking.during })
    .from(booking)
    .where(eq(booking.id, input.bookingId));
  const lines = await ctx.db
    .select({ serviceId: bookingService.serviceId })
    .from(bookingService)
    .where(eq(bookingService.bookingId, input.bookingId))
    .orderBy(asc(bookingService.position));

  const current = { start: row.during.start.toISOString(), end: row.during.end.toISOString() };
  const serviceIds = lines.flatMap((l) => (l.serviceId ? [l.serviceId] : []));
  if (serviceIds.length === 0 || serviceIds.length !== lines.length) {
    return { current, slots: [], reason: "services_not_in_catalogue" };
  }

  const slots = await getAvailableSlots(
    ctx.db,
    {
      locationId: row.locationId,
      staffId: owned.staffId,
      serviceIds,
      fromDate: input.fromDate,
      toDate: input.toDate,
    },
    { excludeBookingId: input.bookingId },
  );
  return { current, slots, reason: null };
}
