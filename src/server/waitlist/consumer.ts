import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { booking, bookingService, waitlistEntry, waitlistOffer } from "@/db/schema";
import type { LogFn } from "@/lib/logger";
import { getBusinessContext } from "../availability/context";
import { recordAudit } from "../audit";
import type { Db } from "../db-types";
import { revertIdleEntries } from "./expire";
import { offerFreedSlot } from "./offers";
import { ACTIVE_ENTRY_STATUSES } from "./shared";
import { windowAcceptsStart } from "./window";

export interface WaitlistEventContext {
  db: Db;
  log: LogFn;
  now: () => Date;
}

const bookingEvent = z.object({ bookingId: z.uuid() });
const rescheduledEvent = bookingEvent.extend({ previousStart: z.string() });

type BookingRow = typeof booking.$inferSelect;

async function loadBooking(db: Db, bookingId: string): Promise<BookingRow | null> {
  const [row] = await db.select().from(booking).where(eq(booking.id, bookingId));
  return row ?? null;
}

/** A booking gave its time back: tidy entries that were waiting on it, then offer the time around. */
async function offerSlotOf(
  ctx: WaitlistEventContext,
  row: BookingRow,
  start: Date,
  end: Date,
): Promise<number> {
  const now = ctx.now();
  await revertIdleEntries(ctx.db, now);
  const { offerIds } = await offerFreedSlot(
    ctx.db,
    {
      staffId: row.staffId,
      locationId: row.locationId,
      start,
      end,
      excludeClientId: row.clientId,
    },
    now,
  );
  return offerIds.length;
}

/** Mark an entry booked and withdraw its other open offers. */
async function markBooked(db: Db, entryId: string, bookingId: string, now: Date): Promise<void> {
  await db
    .update(waitlistEntry)
    .set({ status: "booked", bookedBookingId: bookingId, updatedAt: now })
    .where(
      and(eq(waitlistEntry.id, entryId), inArray(waitlistEntry.status, [...ACTIVE_ENTRY_STATUSES])),
    );
  await db
    .update(waitlistOffer)
    .set({ status: "cancelled" })
    .where(and(eq(waitlistOffer.entryId, entryId), eq(waitlistOffer.status, "sent")));
}

/**
 * A booking was confirmed. If it came from a claimed offer, that entry is booked. Other people offered
 * the same time lose it ("slot_taken") and go back to waiting. Any other entry of the same client that
 * this booking satisfies (same place, stylist, services and window) is archived as booked too.
 */
async function onBookingConfirmed(
  ctx: WaitlistEventContext,
  row: BookingRow,
): Promise<{ booked: number; takenOffers: number }> {
  const { db } = ctx;
  const now = ctx.now();
  const bookingId = row.id;
  const context = await getBusinessContext(db, row.locationId);

  return db.transaction(async (tx) => {
    let booked = 0;

    const claimed = await tx
      .select({ entryId: waitlistOffer.entryId })
      .from(waitlistOffer)
      .where(eq(waitlistOffer.claimedBookingId, bookingId));
    for (const { entryId } of claimed) {
      await markBooked(tx, entryId, bookingId, now);
      booked += 1;
    }

    const taken = await tx
      .update(waitlistOffer)
      .set({ status: "slot_taken" })
      .where(
        and(
          eq(waitlistOffer.staffId, row.staffId),
          eq(waitlistOffer.status, "sent"),
          sql`${waitlistOffer.during} && tstzrange(${row.during.start.toISOString()}::timestamptz, ${row.during.end.toISOString()}::timestamptz, '[)')`,
        ),
      )
      .returning({ id: waitlistOffer.id });

    const services = await tx
      .select({ serviceId: bookingService.serviceId })
      .from(bookingService)
      .where(eq(bookingService.bookingId, bookingId));
    const bookedServiceIds = new Set(services.map((s) => s.serviceId));
    const entries = await tx
      .select()
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.clientId, row.clientId),
          inArray(waitlistEntry.status, [...ACTIVE_ENTRY_STATUSES]),
        ),
      );
    for (const entry of entries) {
      const satisfied =
        entry.locationId === row.locationId &&
        (!entry.staffId || entry.staffId === row.staffId) &&
        entry.serviceIds.every((id) => bookedServiceIds.has(id)) &&
        windowAcceptsStart(entry, row.during.start, context.timezone);
      if (!satisfied) continue;
      await markBooked(tx, entry.id, bookingId, now);
      booked += 1;
    }

    await revertIdleEntries(tx, now);
    if (booked > 0 || taken.length > 0) {
      await recordAudit(tx, {
        actor: "system",
        action: "waitlist.booking_confirmed",
        entityType: "booking",
        entityId: bookingId,
        data: { entriesBooked: booked, offersTaken: taken.length },
      });
    }
    return { booked, takenOffers: taken.length };
  });
}

const MS_PER_MINUTE = 60_000;

/**
 * Reacts to every domain event (the `consumer.waitlist` queue). Idempotent: offers are de-duplicated per
 * entry and slot, and status changes only move forward. Events it does not care about are ignored.
 *
 * - booking.cancelled / booking.expired: the booking's time is free, so offer it.
 * - booking.rescheduled: the old time (previousStart, same length) is free.
 * - booking.confirmed: book the matching entries and close competing offers.
 */
export async function handleWaitlistEvent(
  ctx: WaitlistEventContext,
  data: Record<string, unknown>,
): Promise<void> {
  const { db, log } = ctx;
  switch (data.type) {
    case "booking.cancelled":
    case "booking.expired": {
      const { bookingId } = bookingEvent.parse(data);
      const row = await loadBooking(db, bookingId);
      if (!row) return;
      const offered = await offerSlotOf(ctx, row, row.during.start, row.during.end);
      log({ event: "waitlist_slot_freed", bookingId, offers: offered });
      return;
    }
    case "booking.rescheduled": {
      const { bookingId, previousStart } = rescheduledEvent.parse(data);
      const row = await loadBooking(db, bookingId);
      const start = new Date(previousStart);
      if (!row || Number.isNaN(start.getTime())) return;
      // A stylist change keeps the start; the old stylist is not in the event, so nothing is freed here.
      if (start.getTime() === row.during.start.getTime()) return;
      const length = row.during.end.getTime() - row.during.start.getTime();
      const offered = await offerSlotOf(ctx, row, start, new Date(start.getTime() + length));
      log({
        event: "waitlist_slot_freed",
        bookingId,
        offers: offered,
        minutes: length / MS_PER_MINUTE,
      });
      return;
    }
    case "booking.confirmed": {
      const { bookingId } = bookingEvent.parse(data);
      const row = await loadBooking(db, bookingId);
      if (!row || row.status !== "confirmed") return;
      const result = await onBookingConfirmed(ctx, row);
      log({ event: "waitlist_booking_confirmed", bookingId, ...result });
      return;
    }
    default:
      return;
  }
}
