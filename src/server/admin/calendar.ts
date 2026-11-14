import { and, asc, eq, inArray } from "drizzle-orm";
import { booking, client, location, service, serviceLocation, staff, timeBlock } from "@/db/schema";
import type { TimeRange } from "@/db/tstzrange";
import { recordAudit, type Actor } from "../audit";
import type { Db } from "../db-types";
import { AdminError } from "./errors";
import { fullName, getBusinessContext, loadServiceNames, lowerOf, overlaps } from "./shared";
import type {
  BookingStatus,
  CalendarBlockEvent,
  CalendarBookingEvent,
  CalendarEvent,
  CalendarResources,
} from "./types";

/** Statuses that still mean something on the grid. Cancelled, late-cancelled and expired are hidden. */
const VISIBLE_STATUSES: BookingStatus[] = ["pending_payment", "confirmed", "completed", "no_show"];

export interface CalendarRange {
  from: Date;
  to: Date;
}

/** Bookings and time blocks overlapping [from, to). `locationId` only narrows bookings (blocks belong to a person). */
export async function listCalendarEvents(
  db: Db,
  range: CalendarRange,
  locationId?: string,
  staffId?: string,
): Promise<CalendarEvent[]> {
  const window: TimeRange = { start: range.from, end: range.to };

  const bookingRows = await db
    .select({
      id: booking.id,
      staffId: booking.staffId,
      locationId: booking.locationId,
      status: booking.status,
      during: booking.during,
      totalCents: booking.totalCents,
      source: booking.source,
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .where(
      and(
        overlaps(booking.during, window),
        inArray(booking.status, VISIBLE_STATUSES),
        locationId ? eq(booking.locationId, locationId) : undefined,
        staffId ? eq(booking.staffId, staffId) : undefined,
      ),
    )
    .orderBy(asc(lowerOf(booking.during)));

  const serviceNames = await loadServiceNames(
    db,
    bookingRows.map((b) => b.id),
  );

  const bookingEvents: CalendarBookingEvent[] = bookingRows.map((b) => ({
    kind: "booking",
    id: b.id,
    start: b.during.start.toISOString(),
    end: b.during.end.toISOString(),
    staffId: b.staffId,
    locationId: b.locationId,
    status: b.status,
    clientId: b.clientId,
    clientName: fullName(b.firstName, b.lastName),
    services: serviceNames.get(b.id) ?? [],
    totalCents: b.totalCents,
    source: b.source,
  }));

  const blockRows = await db
    .select()
    .from(timeBlock)
    .where(
      and(overlaps(timeBlock.during, window), staffId ? eq(timeBlock.staffId, staffId) : undefined),
    )
    .orderBy(asc(lowerOf(timeBlock.during)));

  const blockEvents: CalendarBlockEvent[] = blockRows.map((b) => ({
    kind: b.source === "google" ? "external" : "block",
    id: b.id,
    start: b.during.start.toISOString(),
    end: b.during.end.toISOString(),
    staffId: b.staffId,
    reason: b.reason,
  }));

  return [...bookingEvents, ...blockEvents].sort((a, b) => a.start.localeCompare(b.start));
}

/** Everything the calendar UI needs to render filters and the create-booking form. */
export async function listCalendarResources(db: Db): Promise<CalendarResources> {
  const { timezone, settings } = await getBusinessContext(db);

  const locations = await db
    .select({ id: location.id, name: location.name })
    .from(location)
    .where(eq(location.active, true))
    .orderBy(asc(location.sortOrder), asc(location.name));

  const staffRows = await db
    .select({ id: staff.id, name: staff.name })
    .from(staff)
    .where(eq(staff.active, true))
    .orderBy(asc(staff.name));

  const serviceRows = await db
    .select({
      id: service.id,
      name: service.name,
      durationMin: service.durationMin,
      priceCents: service.priceCents,
    })
    .from(service)
    .where(eq(service.active, true))
    .orderBy(asc(service.sortOrder), asc(service.name));

  const offerings = await db.select().from(serviceLocation);
  const byService = new Map<string, string[]>();
  for (const o of offerings) {
    byService.set(o.serviceId, [...(byService.get(o.serviceId) ?? []), o.locationId]);
  }

  return {
    timezone,
    slotStepMin: settings.slotStepMin,
    locations,
    staff: staffRows,
    services: serviceRows.map((s) => ({ ...s, locationIds: byService.get(s.id) ?? [] })),
  };
}

export interface ManualBlockInput {
  staffId: string;
  start: Date;
  end: Date;
  reason?: string;
}

export async function createManualBlock(
  db: Db,
  input: ManualBlockInput,
  actor: Actor,
): Promise<{ blockId: string; overlappingBookings: number }> {
  if (input.end.getTime() <= input.start.getTime()) {
    throw new AdminError("The block must end after the start");
  }
  const during: TimeRange = { start: input.start, end: input.end };
  const reason = input.reason?.trim() || null;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(timeBlock)
      .values({ staffId: input.staffId, during, reason, source: "manual" })
      .returning({ id: timeBlock.id });

    const clashing = await tx
      .select({ id: booking.id })
      .from(booking)
      .where(
        and(
          eq(booking.staffId, input.staffId),
          overlaps(booking.during, during),
          inArray(booking.status, ["pending_payment", "confirmed"]),
        ),
      );

    await recordAudit(tx, {
      actor,
      action: "time_block.created",
      entityType: "time_block",
      entityId: row.id,
      data: {
        staffId: input.staffId,
        start: input.start.toISOString(),
        end: input.end.toISOString(),
        reason,
      },
    });
    return { blockId: row.id, overlappingBookings: clashing.length };
  });
}

export async function deleteBlock(db: Db, blockId: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(timeBlock).where(eq(timeBlock.id, blockId));
    if (!row) throw new AdminError("That blocked time was not found");
    if (row.source === "google") {
      throw new AdminError("This time comes from Google Calendar. Remove it there instead.");
    }
    await tx.delete(timeBlock).where(eq(timeBlock.id, blockId));
    await recordAudit(tx, {
      actor,
      action: "time_block.deleted",
      entityType: "time_block",
      entityId: blockId,
      data: { staffId: row.staffId, start: row.during.start.toISOString() },
    });
  });
}
