import { and, asc, between, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { availabilityRule, location, rosterException, staff } from "@/db/schema";
import type { MinuteRange } from "../admin-foundation/week";
import {
  windowsForDate,
  type DayException,
  type WeeklyRule,
} from "../availability/engine";
import type { Db } from "../db-types";

export interface RosterDayEntry {
  locationId: string;
  locationName: string;
  /** "custom" when a day exception replaced the weekly hours. */
  kind: "weekly" | "custom";
  ranges: MinuteRange[];
}

export interface RosterOff {
  note: string | null;
  /** True when the day off covers every location. */
  everywhere: boolean;
  locationNames: string[];
}

export interface RosterDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  entries: RosterDayEntry[];
  off: RosterOff | null;
}

export interface RosterRow {
  staffId: string;
  name: string;
  colour: string | null;
  days: RosterDay[];
}

export interface RosterOverview {
  weekStart: string;
  /** The seven local dates, Monday first. */
  dates: string[];
  locations: Array<{ id: string; name: string }>;
  rows: RosterRow[];
}

/** The Monday of the week containing `date` (YYYY-MM-DD). */
export function weekStartOf(date: string): string {
  const parsed = DateTime.fromISO(date, { zone: "utc" });
  const day = parsed.isValid ? parsed : DateTime.utc();
  return day.minus({ days: day.weekday - 1 }).toISODate() as string;
}

export function weekDates(weekStart: string): string[] {
  const start = DateTime.fromISO(weekStart, { zone: "utc" });
  return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toISODate() as string);
}

interface RosterOptions {
  /** Any date in the week to show; normalised to its Monday. */
  weekOf: string;
  /** Limit to these stylists (a stylist sees only themselves). Omit for everyone active. */
  staffIds?: string[];
}

/**
 * "Who's working": for each active stylist and each day of the week, where they work and when, after
 * applying day exceptions. Uses the same resolution as the availability search (windowsForDate).
 */
export async function getRosterOverview(db: Db, options: RosterOptions): Promise<RosterOverview> {
  const weekStart = weekStartOf(options.weekOf);
  const dates = weekDates(weekStart);

  const [locations, stylists] = await Promise.all([
    db
      .select({ id: location.id, name: location.name })
      .from(location)
      .where(eq(location.active, true))
      .orderBy(asc(location.sortOrder), asc(location.name)),
    options.staffIds && options.staffIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: staff.id, name: staff.name, colour: staff.colour })
          .from(staff)
          .where(
            and(
              eq(staff.active, true),
              options.staffIds ? inArray(staff.id, options.staffIds) : undefined,
            ),
          )
          .orderBy(asc(staff.name), asc(staff.id)),
  ]);
  if (stylists.length === 0) return { weekStart, dates, locations, rows: [] };

  const staffIds = stylists.map((s) => s.id);
  const [ruleRows, exceptionRows] = await Promise.all([
    db.select().from(availabilityRule).where(inArray(availabilityRule.staffId, staffIds)),
    db
      .select()
      .from(rosterException)
      .where(
        and(
          inArray(rosterException.staffId, staffIds),
          between(rosterException.date, dates[0], dates[6]),
        ),
      ),
  ]);

  const rows = stylists.map((stylist): RosterRow => {
    const days = dates.map((date): RosterDay => {
      const weekday = DateTime.fromISO(date, { zone: "utc" }).weekday % 7;
      const entries: RosterDayEntry[] = [];
      const offLocations: string[] = [];
      let offNote: string | null = null;
      let offEverywhere = false;

      for (const place of locations) {
        const rules: WeeklyRule[] = ruleRows
          .filter((r) => r.staffId === stylist.id && r.locationId === place.id)
          .map((r) => ({
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
            validFrom: r.validFrom,
            validTo: r.validTo,
          }));
        const here = exceptionRows.filter(
          (e) =>
            e.staffId === stylist.id &&
            e.date === date &&
            (e.locationId === null || e.locationId === place.id),
        );
        const exceptions: DayException[] = here.map((e) => ({
          date: e.date,
          kind: e.kind,
          startMinute: e.startMinute,
          endMinute: e.endMinute,
        }));

        const offRow = here.find((e) => e.kind === "off");
        if (offRow) {
          offLocations.push(place.name);
          offNote = offNote ?? offRow.note;
          if (offRow.locationId === null) offEverywhere = true;
          continue;
        }
        const windows = windowsForDate(rules, exceptions, weekday, date);
        if (windows.length === 0) continue;
        entries.push({
          locationId: place.id,
          locationName: place.name,
          kind: here.some((e) => e.kind === "custom") ? "custom" : "weekly",
          ranges: [...windows].sort((a, b) => a.startMinute - b.startMinute),
        });
      }

      return {
        date,
        entries,
        off:
          offLocations.length > 0
            ? { note: offNote, everywhere: offEverywhere, locationNames: offLocations }
            : null,
      };
    });
    return { staffId: stylist.id, name: stylist.name, colour: stylist.colour, days };
  });

  return { weekStart, dates, locations, rows };
}
