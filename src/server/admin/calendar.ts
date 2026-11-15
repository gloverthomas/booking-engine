import { and, asc, eq, inArray } from "drizzle-orm";
import { booking, client, location, service, serviceLocation, timeBlock } from "@/db/schema";
import type { TimeRange } from "@/db/tstzrange";
import { recordAudit, type Actor } from "../audit";
import type { Db } from "../db-types";
import {
  assertCanViewCalendar,
  canAccessStaffMember,
  effectiveStaffIds,
  NOT_ALLOWED_MESSAGE,
  viewerCaps,
  type AccessContext,
} from "./access";
import { AdminError } from "./errors";
import {
  fullName,
  getBusinessContext,
  loadServiceNames,
  loadStaffDirectory,
  lowerOf,
  overlaps,
} from "./shared";
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

export interface CalendarFilter {
  /** Only narrows bookings: blocks belong to a person, not a place. */
  locationId?: string;
  /** Which stylists to show. Empty or missing means everyone the viewer may see. */
  staffIds?: readonly string[];
}

/**
 * Bookings and time blocks overlapping [from, to), limited to what `access` may see: a stylist only ever
 * gets their own bookings and blocks, whatever `filter.staffIds` asks for.
 */
export async function listCalendarEvents(
  db: Db,
  range: CalendarRange,
  access: AccessContext,
  filter: CalendarFilter = {},
): Promise<CalendarEvent[]> {
  assertCanViewCalendar(access);
  const window: TimeRange = { start: range.from, end: range.to };
  const staffIds = effectiveStaffIds(access, filter.staffIds);
  if (staffIds && staffIds.length === 0) return [];
  const { locationId } = filter;

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
        staffIds ? inArray(booking.staffId, staffIds) : undefined,
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
      and(
        overlaps(timeBlock.during, window),
        staffIds ? inArray(timeBlock.staffId, staffIds) : undefined,
      ),
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

/**
 * Everything the calendar UI needs to render filters and the create-booking form. A stylist's `staff`
 * list is just themselves, so colleagues' names never reach their browser.
 */
export async function listCalendarResources(
  db: Db,
  access: AccessContext,
): Promise<CalendarResources> {
  assertCanViewCalendar(access);
  const { timezone, settings } = await getBusinessContext(db);

  const locations = await db
    .select({ id: location.id, name: location.name })
    .from(location)
    .where(eq(location.active, true))
    .orderBy(asc(location.sortOrder), asc(location.name));

  const visible = effectiveStaffIds(access);
  const staffRows = (await loadStaffDirectory(db))
    .filter((s) => s.active && (!visible || visible.includes(s.id)))
    .map(({ id, name, colour }) => ({ id, name, colour }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
    viewer: viewerCaps(access),
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
  access: AccessContext,
): Promise<{ blockId: string; overlappingBookings: number }> {
  assertCanViewCalendar(access);
  // A stylist can only block their own time.
  if (!canAccessStaffMember(access, input.staffId)) throw new AdminError(NOT_ALLOWED_MESSAGE);
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

export async function deleteBlock(
  db: Db,
  blockId: string,
  actor: Actor,
  access: AccessContext,
): Promise<void> {
  assertCanViewCalendar(access);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(timeBlock).where(eq(timeBlock.id, blockId));
    // Someone else's block is reported as missing, the same as a stylist's view of their booking.
    if (!row || !canAccessStaffMember(access, row.staffId)) {
      throw new AdminError("That blocked time was not found");
    }
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
