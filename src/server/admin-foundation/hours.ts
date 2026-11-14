import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  availabilityRule,
  booking,
  location,
  SLOT_HOLDING_STATUSES,
  staff,
  timeBlock,
} from "@/db/schema";
import { formatRange } from "@/db/tstzrange";
import { recordAudit, type Actor } from "@/server/audit";
import type { Db } from "@/server/db-types";
import { AdminError } from "./errors";
import { rulesToWeek, validateRanges, weekToRules, WEEKDAYS_MON_FIRST, type Week } from "./week";

/* -------------------------------------------------------------------------- */
/* Weekly hours                                                               */
/* -------------------------------------------------------------------------- */

/** The recurring week for one stylist at one location (open-ended rules only). */
export async function getWeeklyHours(db: Db, staffId: string, locationId: string): Promise<Week> {
  const rows = await db
    .select()
    .from(availabilityRule)
    .where(
      and(
        eq(availabilityRule.staffId, staffId),
        eq(availabilityRule.locationId, locationId),
        isNull(availabilityRule.validFrom),
        isNull(availabilityRule.validTo),
      ),
    );
  return rulesToWeek(rows);
}

export interface SaveWeeklyHoursInput {
  staffId: string;
  locationId: string;
  week: Week;
}

/** Replaces the open-ended weekly rules for the stylist+location. Date-bounded rules are left untouched. */
export async function saveWeeklyHours(
  db: Db,
  actor: Actor,
  input: SaveWeeklyHoursInput,
): Promise<void> {
  for (const day of WEEKDAYS_MON_FIRST) {
    const problem = validateRanges(input.week[day.index] ?? []);
    if (problem) throw new AdminError("invalid_hours", `${day.label}: ${problem}`);
  }
  const rules = weekToRules(input.week);

  await db.transaction(async (tx) => {
    const [stylist] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.id, input.staffId));
    if (!stylist) throw new AdminError("not_found", "Stylist not found.");
    const [place] = await tx
      .select({ id: location.id })
      .from(location)
      .where(eq(location.id, input.locationId));
    if (!place) throw new AdminError("not_found", "Location not found.");

    await tx
      .delete(availabilityRule)
      .where(
        and(
          eq(availabilityRule.staffId, input.staffId),
          eq(availabilityRule.locationId, input.locationId),
          isNull(availabilityRule.validFrom),
          isNull(availabilityRule.validTo),
        ),
      );
    if (rules.length > 0) {
      await tx.insert(availabilityRule).values(
        rules.map((rule) => ({
          staffId: input.staffId,
          locationId: input.locationId,
          weekday: rule.weekday,
          startMinute: rule.startMinute,
          endMinute: rule.endMinute,
        })),
      );
    }
    await recordAudit(tx, {
      actor,
      action: "hours.updated",
      entityType: "availability_rule",
      entityId: `${input.staffId}:${input.locationId}`,
      data: { staffId: input.staffId, locationId: input.locationId, ranges: rules.length },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Local date-time <-> UTC                                                    */
/* -------------------------------------------------------------------------- */

/** "2030-01-15T09:00" typed by the owner, read in the business timezone, returned as a UTC Date. */
export function localInputToDate(value: string, timezone: string): Date | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone: timezone });
  return parsed.isValid ? parsed.toJSDate() : null;
}

/** Inverse of localInputToDate: value for an <input type="datetime-local">. */
export function toLocalInputValue(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat("yyyy-MM-dd'T'HH:mm");
}

/* -------------------------------------------------------------------------- */
/* Time off / blocked time                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateTimeBlockInput {
  staffId: string;
  /** datetime-local value, business timezone. */
  start: string;
  end: string;
  reason?: string | null;
}

export async function createTimeBlock(
  db: Db,
  actor: Actor,
  input: CreateTimeBlockInput,
  timezone: string,
): Promise<{ id: string; conflictingBookings: number }> {
  const start = localInputToDate(input.start, timezone);
  const end = localInputToDate(input.end, timezone);
  if (!start)
    throw new AdminError("invalid_time", "Enter a valid start date and time.", {
      start: "Invalid",
    });
  if (!end)
    throw new AdminError("invalid_time", "Enter a valid end date and time.", { end: "Invalid" });
  if (end <= start) {
    throw new AdminError("invalid_time", "The end must be after the start.", {
      end: "Must be after start",
    });
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  return db.transaction(async (tx) => {
    const [stylist] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.id, input.staffId));
    if (!stylist) throw new AdminError("not_found", "Stylist not found.");

    const range = formatRange({ start, end });
    const [clash] = await tx
      .select({ n: count() })
      .from(booking)
      .where(
        and(
          eq(booking.staffId, input.staffId),
          inArray(booking.status, [...SLOT_HOLDING_STATUSES]),
          sql`${booking.during} && ${range}::tstzrange`,
        ),
      );

    const [created] = await tx
      .insert(timeBlock)
      .values({ staffId: input.staffId, during: { start, end }, reason, source: "manual" })
      .returning({ id: timeBlock.id });
    if (!created) throw new Error("Insert returned no row");

    await recordAudit(tx, {
      actor,
      action: "timeblock.created",
      entityType: "time_block",
      entityId: created.id,
      data: { staffId: input.staffId, start: start.toISOString(), end: end.toISOString(), reason },
    });
    return { id: created.id, conflictingBookings: clash?.n ?? 0 };
  });
}

export interface TimeBlockListItem {
  id: string;
  staffId: string;
  staffName: string;
  start: Date;
  end: Date;
  reason: string | null;
}

/** Manual blocks that have not finished yet, soonest first. Imported Google busy time is not listed here. */
export async function listTimeBlocks(db: Db, now: Date = new Date()): Promise<TimeBlockListItem[]> {
  const rows = await db
    .select({
      id: timeBlock.id,
      staffId: timeBlock.staffId,
      staffName: staff.name,
      during: timeBlock.during,
      reason: timeBlock.reason,
    })
    .from(timeBlock)
    .innerJoin(staff, eq(staff.id, timeBlock.staffId))
    .where(
      and(
        eq(timeBlock.source, "manual"),
        sql`upper(${timeBlock.during}) > ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(sql`lower(${timeBlock.during})`));
  return rows.map((row) => ({
    id: row.id,
    staffId: row.staffId,
    staffName: row.staffName,
    start: row.during.start,
    end: row.during.end,
    reason: row.reason,
  }));
}

export async function deleteTimeBlock(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ source: timeBlock.source, staffId: timeBlock.staffId })
      .from(timeBlock)
      .where(eq(timeBlock.id, id));
    if (!row) throw new AdminError("not_found", "Time block not found.");
    if (row.source !== "manual") {
      throw new AdminError(
        "read_only",
        "This busy time comes from Google Calendar. Remove or move the event in Google instead.",
      );
    }
    await tx.delete(timeBlock).where(eq(timeBlock.id, id));
    await recordAudit(tx, {
      actor,
      action: "timeblock.deleted",
      entityType: "time_block",
      entityId: id,
      data: { staffId: row.staffId },
    });
  });
}
