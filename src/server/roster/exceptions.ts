import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { booking, location, rosterException, SLOT_HOLDING_STATUSES, staff } from "@/db/schema";
import { getBusiness } from "../admin-foundation/business";
import { AdminError } from "../admin-foundation/errors";
import { validateRanges } from "../admin-foundation/week";
import { rosterCovers } from "../availability/engine";
import { loadExceptions, loadRules } from "../availability/loader";
import { recordAudit, type Actor } from "../audit";
import type { Db } from "../db-types";
import type { CustomHoursInput, DayOffInput } from "./schemas";

export interface ExceptionResult {
  /** Rows now stored for this staff, date and location. */
  ids: string[];
  /** Existing bookings that fall outside the roster after this change. Never blocks the change. */
  conflictingBookings: number;
}

export interface ExceptionListItem {
  id: string;
  staffId: string;
  staffName: string;
  date: string;
  kind: "off" | "custom";
  locationId: string | null;
  /** Null = every location. */
  locationName: string | null;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
}

async function requireStaffAndLocation(
  db: Db,
  staffId: string,
  locationId: string | null,
): Promise<void> {
  const [stylist] = await db.select({ id: staff.id }).from(staff).where(eq(staff.id, staffId));
  if (!stylist) throw new AdminError("not_found", "Stylist not found.");
  if (locationId) {
    const [place] = await db
      .select({ id: location.id })
      .from(location)
      .where(eq(location.id, locationId));
    if (!place) throw new AdminError("not_found", "Location not found.");
  }
}

/** Past days cannot be changed: they are history. Today is allowed. */
function requireNotPast(date: string, timezone: string, now: Date): void {
  const today = DateTime.fromJSDate(now, { zone: timezone }).toISODate() as string;
  if (date < today) {
    throw new AdminError("past_date", "Choose today or a later date.", {
      date: "Must be today or later",
    });
  }
}

/** Replace anything already set for this staff, date and location scope (null = everywhere). */
async function clearScope(
  db: Db,
  staffId: string,
  date: string,
  locationId: string | null,
): Promise<number> {
  const removed = await db
    .delete(rosterException)
    .where(
      and(
        eq(rosterException.staffId, staffId),
        eq(rosterException.date, date),
        locationId
          ? eq(rosterException.locationId, locationId)
          : isNull(rosterException.locationId),
      ),
    )
    .returning({ id: rosterException.id });
  return removed.length;
}

/**
 * How many live bookings on `date` are no longer inside the stylist's roster. Used to warn after a
 * change (the owner decides what to do about them); `locationId` limits it to one location.
 */
export async function countBookingsOutsideRoster(
  db: Db,
  staffId: string,
  date: string,
  locationId: string | null,
  timezone: string,
): Promise<number> {
  const dayStart = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  const rows = await db
    .select({ locationId: booking.locationId, during: booking.during })
    .from(booking)
    .where(
      and(
        eq(booking.staffId, staffId),
        inArray(booking.status, [...SLOT_HOLDING_STATUSES]),
        locationId ? eq(booking.locationId, locationId) : undefined,
        sql`${booking.during} && tstzrange(${dayStart.toJSDate().toISOString()}::timestamptz, ${dayStart.plus({ days: 1 }).toJSDate().toISOString()}::timestamptz, '[)')`,
      ),
    );

  let outside = 0;
  for (const row of rows) {
    const [rules, exceptions] = await Promise.all([
      loadRules(db, row.locationId, [staffId]),
      loadExceptions(db, row.locationId, [staffId], date, date),
    ]);
    if (
      !rosterCovers(rules.get(staffId) ?? [], exceptions.get(staffId) ?? [], timezone, row.during)
    ) {
      outside += 1;
    }
  }
  return outside;
}

/** Mark a stylist off for a day (one location, or everywhere when locationId is null). Replaces what was set. */
export async function setDayOff(
  db: Db,
  actor: Actor,
  input: DayOffInput,
  now: Date = new Date(),
): Promise<ExceptionResult> {
  const { timezone } = await getBusiness(db);
  requireNotPast(input.date, timezone, now);

  return db.transaction(async (tx) => {
    await requireStaffAndLocation(tx, input.staffId, input.locationId);
    await clearScope(tx, input.staffId, input.date, input.locationId);
    const [created] = await tx
      .insert(rosterException)
      .values({
        staffId: input.staffId,
        locationId: input.locationId,
        date: input.date,
        kind: "off",
        note: input.note,
      })
      .returning({ id: rosterException.id });
    if (!created) throw new Error("Insert returned no row");

    await recordAudit(tx, {
      actor,
      action: "roster.day_off",
      entityType: "roster_exception",
      entityId: created.id,
      data: {
        staffId: input.staffId,
        date: input.date,
        locationId: input.locationId,
        note: input.note,
      },
    });
    return {
      ids: [created.id],
      conflictingBookings: await countBookingsOutsideRoster(
        tx,
        input.staffId,
        input.date,
        input.locationId,
        timezone,
      ),
    };
  });
}

/** Replace a stylist's hours at one location on one date with the given ranges. */
export async function setCustomHours(
  db: Db,
  actor: Actor,
  input: CustomHoursInput,
  now: Date = new Date(),
): Promise<ExceptionResult> {
  const problem = validateRanges(input.ranges);
  if (problem) throw new AdminError("invalid_hours", problem, { ranges: problem });
  const { timezone } = await getBusiness(db);
  requireNotPast(input.date, timezone, now);

  return db.transaction(async (tx) => {
    await requireStaffAndLocation(tx, input.staffId, input.locationId);
    await clearScope(tx, input.staffId, input.date, input.locationId);
    const created = await tx
      .insert(rosterException)
      .values(
        input.ranges.map((range) => ({
          staffId: input.staffId,
          locationId: input.locationId,
          date: input.date,
          kind: "custom" as const,
          startMinute: range.startMinute,
          endMinute: range.endMinute,
          note: input.note,
        })),
      )
      .returning({ id: rosterException.id });

    await recordAudit(tx, {
      actor,
      action: "roster.custom_hours",
      entityType: "roster_exception",
      entityId: `${input.staffId}:${input.date}:${input.locationId}`,
      data: {
        staffId: input.staffId,
        date: input.date,
        locationId: input.locationId,
        ranges: input.ranges,
        note: input.note,
      },
    });
    return {
      ids: created.map((row) => row.id),
      conflictingBookings: await countBookingsOutsideRoster(
        tx,
        input.staffId,
        input.date,
        input.locationId,
        timezone,
      ),
    };
  });
}

/** Remove one exception row so the weekly hours apply again that day. */
export async function removeException(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(rosterException).where(eq(rosterException.id, id));
    if (!row) throw new AdminError("not_found", "That exception no longer exists.");
    await tx.delete(rosterException).where(eq(rosterException.id, id));
    await recordAudit(tx, {
      actor,
      action: "roster.exception_removed",
      entityType: "roster_exception",
      entityId: id,
      data: { staffId: row.staffId, date: row.date, kind: row.kind, locationId: row.locationId },
    });
  });
}

/** Exceptions from `fromDate` on, soonest first. Pass staffIds to scope the list (a stylist sees only their own). */
export async function listExceptions(
  db: Db,
  options: { fromDate: string; staffIds?: string[] },
): Promise<ExceptionListItem[]> {
  if (options.staffIds && options.staffIds.length === 0) return [];
  const rows = await db
    .select({
      id: rosterException.id,
      staffId: rosterException.staffId,
      staffName: staff.name,
      date: rosterException.date,
      kind: rosterException.kind,
      locationId: rosterException.locationId,
      locationName: location.name,
      startMinute: rosterException.startMinute,
      endMinute: rosterException.endMinute,
      note: rosterException.note,
    })
    .from(rosterException)
    .innerJoin(staff, eq(staff.id, rosterException.staffId))
    .leftJoin(location, eq(location.id, rosterException.locationId))
    .where(
      and(
        gte(rosterException.date, options.fromDate),
        options.staffIds ? inArray(rosterException.staffId, options.staffIds) : undefined,
      ),
    )
    .orderBy(asc(rosterException.date), asc(staff.name), asc(rosterException.startMinute));
  return rows;
}
