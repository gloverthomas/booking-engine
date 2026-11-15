import { and, asc, between, gte, inArray, lt } from "drizzle-orm";
import { DateTime } from "luxon";
import { availabilityRule, location, rosterException, staff, timeEntry } from "@/db/schema";
import { systemClock, type Clock } from "../clock";
import type { StaffRole } from "../contracts";
import type { Db } from "../db-types";
import { rosteredMinutesForDay, type ExceptionLike, type RuleLike } from "./rostered";
import { netMinutes, weekBounds, weekDates } from "./time";

export type TimeEntryStatus = "open" | "pending" | "approved";

export interface TimesheetEntryView {
  id: string;
  staffId: string;
  /** Local date the shift started on (the day it is counted against). */
  date: string;
  locationId: string | null;
  locationName: string | null;
  clockIn: Date;
  clockOut: Date | null;
  breakMinutes: number;
  /** Minutes worked after the break. For an open entry: so far, up to now. */
  netMinutes: number;
  source: "clock" | "manual";
  note: string | null;
  status: TimeEntryStatus;
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface TimesheetDay {
  date: string;
  /** The day has finished (it is before today in the business time zone). */
  complete: boolean;
  workedMinutes: number;
  rosteredMinutes: number;
  /** worked - rostered. Null until the day has finished, so a half-done day never reads as a shortfall. */
  differenceMinutes: number | null;
  entries: TimesheetEntryView[];
}

export interface WeeklyTimesheet {
  staffId: string;
  staffName: string;
  role: StaffRole;
  /** Local date of the Monday. */
  weekStart: string;
  days: TimesheetDay[];
  workedMinutes: number;
  breakMinutes: number;
  /** Rostered for the whole week. */
  rosteredMinutes: number;
  /** worked - rostered, counting finished days only. */
  differenceMinutes: number;
  hasOpenEntry: boolean;
  /** Finished entries still waiting for approval. */
  pendingCount: number;
  approvedCount: number;
}

export interface BuildInput {
  person: { id: string; name: string; role: StaffRole };
  entries: ReadonlyArray<typeof timeEntry.$inferSelect>;
  rules: readonly RuleLike[];
  exceptions: readonly ExceptionLike[];
  locationNames: ReadonlyMap<string, string>;
  weekStart: string;
  timezone: string;
  now: Date;
}

function statusOf(row: { clockOut: Date | null; approvedAt: Date | null }): TimeEntryStatus {
  if (!row.clockOut) return "open";
  return row.approvedAt ? "approved" : "pending";
}

/** One person's week from already loaded rows. Pure, so the rules are easy to test. */
export function buildWeeklyTimesheet(input: BuildInput): WeeklyTimesheet {
  const { person, weekStart, timezone, now } = input;
  const today = DateTime.fromJSDate(now, { zone: timezone }).toISODate() ?? "";

  const views: TimesheetEntryView[] = input.entries
    .map((row) => ({
      id: row.id,
      staffId: row.staffId,
      date: DateTime.fromJSDate(row.clockIn, { zone: timezone }).toISODate() ?? "",
      locationId: row.locationId,
      locationName: row.locationId ? (input.locationNames.get(row.locationId) ?? null) : null,
      clockIn: row.clockIn,
      clockOut: row.clockOut,
      breakMinutes: row.breakMinutes,
      netMinutes: row.clockOut
        ? netMinutes(row.clockIn, row.clockOut, row.breakMinutes)
        : now > row.clockIn
          ? netMinutes(row.clockIn, now, 0)
          : 0,
      source: row.source,
      note: row.note,
      status: statusOf(row),
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy,
    }))
    .sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());

  const days: TimesheetDay[] = weekDates(weekStart).map((date) => {
    const entries = views.filter((v) => v.date === date);
    const worked = entries.reduce((sum, e) => sum + e.netMinutes, 0);
    const rostered = rosteredMinutesForDay(input.rules, input.exceptions, date, timezone);
    const complete = date < today;
    return {
      date,
      complete,
      workedMinutes: worked,
      rosteredMinutes: rostered,
      differenceMinutes: complete ? worked - rostered : null,
      entries,
    };
  });

  return {
    staffId: person.id,
    staffName: person.name,
    role: person.role,
    weekStart,
    days,
    workedMinutes: days.reduce((s, d) => s + d.workedMinutes, 0),
    breakMinutes: views.reduce((s, v) => s + v.breakMinutes, 0),
    rosteredMinutes: days.reduce((s, d) => s + d.rosteredMinutes, 0),
    differenceMinutes: days.reduce((s, d) => s + (d.differenceMinutes ?? 0), 0),
    hasOpenEntry: views.some((v) => v.status === "open"),
    pendingCount: views.filter((v) => v.status === "pending").length,
    approvedCount: views.filter((v) => v.status === "approved").length,
  };
}

export interface WeeklyQuery {
  timezone: string;
  /** Local date of the Monday (see weekStartOf). */
  weekStart: string;
  /** Only these people. Omit for the whole team (active staff, plus anyone with time that week). */
  staffIds?: readonly string[];
}

/** Worked, rostered and difference for each person for one week, sorted by name. */
export async function getWeeklyTimesheets(
  db: Db,
  query: WeeklyQuery,
  clock: Clock = systemClock,
): Promise<WeeklyTimesheet[]> {
  const { start, endExclusive } = weekBounds(query.timezone, query.weekStart);
  const dates = weekDates(query.weekStart);
  const onlyIds = query.staffIds;
  if (onlyIds && onlyIds.length === 0) return [];

  const entries = await db
    .select()
    .from(timeEntry)
    .where(
      and(
        gte(timeEntry.clockIn, start),
        lt(timeEntry.clockIn, endExclusive),
        onlyIds ? inArray(timeEntry.staffId, [...onlyIds]) : undefined,
      ),
    );

  const people = onlyIds
    ? await db
        .select({ id: staff.id, name: staff.name, role: staff.role })
        .from(staff)
        .where(inArray(staff.id, [...onlyIds]))
        .orderBy(asc(staff.name))
    : (
        await db
          .select({ id: staff.id, name: staff.name, role: staff.role, active: staff.active })
          .from(staff)
          .orderBy(asc(staff.name))
      ).filter((p) => p.active || entries.some((e) => e.staffId === p.id));
  if (people.length === 0) return [];
  const ids = people.map((p) => p.id);

  const [rules, exceptions, locations] = await Promise.all([
    db.select().from(availabilityRule).where(inArray(availabilityRule.staffId, ids)),
    db
      .select()
      .from(rosterException)
      .where(
        and(
          inArray(rosterException.staffId, ids),
          between(rosterException.date, dates[0], dates[6]),
        ),
      ),
    db.select({ id: location.id, name: location.name }).from(location),
  ]);
  const locationNames = new Map(locations.map((l) => [l.id, l.name]));
  const now = clock();

  return people.map((person) =>
    buildWeeklyTimesheet({
      person,
      entries: entries.filter((e) => e.staffId === person.id),
      rules: rules.filter((r) => r.staffId === person.id),
      exceptions: exceptions.filter((e) => e.staffId === person.id),
      locationNames,
      weekStart: query.weekStart,
      timezone: query.timezone,
      now,
    }),
  );
}

/** One person's week. */
export async function getWeeklyTimesheet(
  db: Db,
  query: { timezone: string; weekStart: string; staffId: string },
  clock: Clock = systemClock,
): Promise<WeeklyTimesheet | null> {
  const [sheet] = await getWeeklyTimesheets(
    db,
    { timezone: query.timezone, weekStart: query.weekStart, staffIds: [query.staffId] },
    clock,
  );
  return sheet ?? null;
}
