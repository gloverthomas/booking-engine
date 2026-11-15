import { and, between, eq, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { availabilityRule, booking, location, rosterException, staff, timeBlock } from "@/db/schema";
import type { Db } from "../db-types";
import { rosterIntervalsForDay } from "../timesheets/rostered";
import { eachLocalDate, resolveRange, type ResolvedRange } from "./range";

export type BookingStatusName = (typeof booking.$inferSelect)["status"];

export const ALL_STATUSES: readonly BookingStatusName[] = [
  "pending_payment",
  "confirmed",
  "completed",
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
  "no_show",
  "expired",
];

/** Statuses that represent a real appointment on the books (used for counts, hours and visits). */
export const HONOURED_STATUSES: readonly BookingStatusName[] = ["confirmed", "completed"];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type BookingsGroupBy = "location" | "staff";

export interface BookingsQuery {
  timezone: string;
  from: string;
  to: string;
  /** Only this stylist's appointments and rostered hours. Role scoping sets this on the server. */
  staffId?: string;
  /** "staff" also fills `byStaff`. Locations are always reported. */
  groupBy?: BookingsGroupBy;
}

export interface StaffUtilisationRow {
  staffId: string;
  staffName: string;
  bookings: number;
  bookedHours: number;
  availableHours: number;
  utilisationPct: number | null;
}

export interface UtilisationRow {
  locationId: string;
  locationName: string;
  bookings: number;
  bookedHours: number;
  availableHours: number;
  /** booked / available as a percentage, null when there are no available hours. */
  utilisationPct: number | null;
}

export interface BookingsReport {
  range: ResolvedRange;
  statusCounts: Record<BookingStatusName, number>;
  /** Confirmed + completed appointments starting in the range. */
  bookedCount: number;
  bookedHours: number;
  /** Hours from weekly availability rules, minus time blocks. Bookings are not subtracted. */
  availableHours: number;
  utilisationPct: number | null;
  byLocation: UtilisationRow[];
  /** Per stylist. Empty unless the query asked for groupBy "staff". */
  byStaff: StaffUtilisationRow[];
  byDay: Array<{ date: string; bookings: number; bookedHours: number }>;
  byWeekday: Array<{ weekday: number; label: string; bookings: number }>;
  byHour: Array<{ hour: number; label: string; bookings: number }>;
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  return sorted.reduce<Interval[]>((merged, cur) => {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) {
      return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, cur.end) }];
    }
    return [...merged, cur];
  }, []);
}

function overlapMs(a: Interval, merged: readonly Interval[]): number {
  return merged.reduce(
    (sum, b) => sum + Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)),
    0,
  );
}

const hoursOf = (ms: number): number => ms / 3_600_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (booked: number, available: number): number | null =>
  available > 0 ? Math.round((booked / available) * 1000) / 10 : null;

interface OpenHours {
  staffId: string;
  /** Null only for a custom roster day that had no weekly rule to take a location from. */
  locationId: string | null;
  hours: number;
}

/**
 * Open hours per stylist and location for the range: the weekly roster (valid_from / valid_to respected, with
 * each day's roster exceptions applied) minus time blocks. Bookings are not subtracted.
 */
async function openHours(db: Db, range: ResolvedRange, staffId?: string): Promise<OpenHours[]> {
  const dates = eachLocalDate(range);
  const [rules, exceptions, blocks] = await Promise.all([
    db
      .select()
      .from(availabilityRule)
      .where(staffId ? eq(availabilityRule.staffId, staffId) : undefined),
    db
      .select()
      .from(rosterException)
      .where(
        and(
          between(rosterException.date, dates[0], dates[dates.length - 1]),
          staffId ? eq(rosterException.staffId, staffId) : undefined,
        ),
      ),
    db
      .select({ staffId: timeBlock.staffId, during: timeBlock.during })
      .from(timeBlock)
      .where(
        and(
          sql`${timeBlock.during} && tstzrange(${range.start.toISOString()}::timestamptz, ${range.endExclusive.toISOString()}::timestamptz, '[)')`,
          staffId ? eq(timeBlock.staffId, staffId) : undefined,
        ),
      ),
  ]);

  const group = <T extends { staffId: string }>(list: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const item of list) map.set(item.staffId, [...(map.get(item.staffId) ?? []), item]);
    return map;
  };
  const rulesByStaff = group(rules);
  const exceptionsByStaff = group(exceptions);
  const blocksByStaff = new Map(
    [...group(blocks)].map(([id, list]) => [
      id,
      mergeIntervals(
        list.map((b) => ({ start: b.during.start.getTime(), end: b.during.end.getTime() })),
      ),
    ]),
  );
  const staffIds = new Set([...rulesByStaff.keys(), ...exceptionsByStaff.keys()]);

  const hours = new Map<string, OpenHours>();
  for (const id of staffIds) {
    const own = { rules: rulesByStaff.get(id) ?? [], exceptions: exceptionsByStaff.get(id) ?? [] };
    for (const date of dates) {
      for (const interval of rosterIntervalsForDay(own.rules, own.exceptions, date, range.timezone)) {
        const open = Math.max(
          0,
          interval.end - interval.start - overlapMs(interval, blocksByStaff.get(id) ?? []),
        );
        const key = `${id}|${interval.locationId ?? ""}`;
        const existing = hours.get(key);
        hours.set(key, {
          staffId: id,
          locationId: interval.locationId,
          hours: (existing?.hours ?? 0) + hoursOf(open),
        });
      }
    }
  }
  return [...hours.values()];
}

/** Booking volume, utilisation and busiest days/times for appointments starting in the range. */
export async function getBookingsReport(db: Db, query: BookingsQuery): Promise<BookingsReport> {
  const range = resolveRange(query.timezone, query.from, query.to);
  const [rows, locations, people, open] = await Promise.all([
    db
      .select({
        status: booking.status,
        locationId: booking.locationId,
        staffId: booking.staffId,
        during: booking.during,
      })
      .from(booking)
      .where(
        and(
          gte(sql`lower(${booking.during})`, range.start),
          lt(sql`lower(${booking.during})`, range.endExclusive),
          query.staffId ? eq(booking.staffId, query.staffId) : undefined,
        ),
      ),
    db.select({ id: location.id, name: location.name }).from(location),
    db.select({ id: staff.id, name: staff.name }).from(staff),
    openHours(db, range, query.staffId),
  ]);
  const availableByLocation = new Map<string, number>();
  const availableByStaff = new Map<string, number>();
  for (const o of open) {
    if (o.locationId) {
      availableByLocation.set(o.locationId, (availableByLocation.get(o.locationId) ?? 0) + o.hours);
    }
    availableByStaff.set(o.staffId, (availableByStaff.get(o.staffId) ?? 0) + o.hours);
  }

  const statusCounts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    BookingStatusName,
    number
  >;
  const days = new Map(eachLocalDate(range).map((d) => [d, { bookings: 0, bookedHours: 0 }]));
  const weekdays = new Array<number>(7).fill(0);
  const hoursOfDay = new Array<number>(24).fill(0);
  const perLocation = new Map<string, { bookings: number; bookedHours: number }>();
  const perStaff = new Map<string, { bookings: number; bookedHours: number }>();

  for (const row of rows) {
    statusCounts[row.status] += 1;
    if (!HONOURED_STATUSES.includes(row.status)) continue;
    const local = DateTime.fromJSDate(row.during.start, { zone: range.timezone });
    const hours = hoursOf(row.during.end.getTime() - row.during.start.getTime());
    const dayKey = local.toISODate() ?? "";
    const day = days.get(dayKey) ?? { bookings: 0, bookedHours: 0 };
    days.set(dayKey, { bookings: day.bookings + 1, bookedHours: day.bookedHours + hours });
    weekdays[local.weekday % 7] += 1;
    hoursOfDay[local.hour] += 1;
    const loc = perLocation.get(row.locationId) ?? { bookings: 0, bookedHours: 0 };
    perLocation.set(row.locationId, {
      bookings: loc.bookings + 1,
      bookedHours: loc.bookedHours + hours,
    });
    const own = perStaff.get(row.staffId) ?? { bookings: 0, bookedHours: 0 };
    perStaff.set(row.staffId, {
      bookings: own.bookings + 1,
      bookedHours: own.bookedHours + hours,
    });
  }

  const nameOf = new Map(locations.map((l) => [l.id, l.name]));
  const locationIds = [...new Set([...perLocation.keys(), ...availableByLocation.keys()])];
  const byLocation: UtilisationRow[] = locationIds
    .map((id) => {
      const booked = perLocation.get(id) ?? { bookings: 0, bookedHours: 0 };
      const available = availableByLocation.get(id) ?? 0;
      return {
        locationId: id,
        locationName: nameOf.get(id) ?? "Unknown location",
        bookings: booked.bookings,
        bookedHours: round2(booked.bookedHours),
        availableHours: round2(available),
        utilisationPct: pct(booked.bookedHours, available),
      };
    })
    .sort((a, b) => a.locationName.localeCompare(b.locationName));

  const bookedHours = [...perLocation.values()].reduce((s, l) => s + l.bookedHours, 0);
  const availableHours = [...availableByStaff.values()].reduce((s, h) => s + h, 0);

  const staffName = new Map(people.map((p) => [p.id, p.name]));
  const byStaff: StaffUtilisationRow[] =
    query.groupBy === "staff"
      ? [...new Set([...perStaff.keys(), ...availableByStaff.keys()])]
          .map((id) => {
            const booked = perStaff.get(id) ?? { bookings: 0, bookedHours: 0 };
            const available = availableByStaff.get(id) ?? 0;
            return {
              staffId: id,
              staffName: staffName.get(id) ?? "Unknown stylist",
              bookings: booked.bookings,
              bookedHours: round2(booked.bookedHours),
              availableHours: round2(available),
              utilisationPct: pct(booked.bookedHours, available),
            };
          })
          .sort((a, b) => a.staffName.localeCompare(b.staffName))
      : [];

  return {
    range,
    statusCounts,
    bookedCount: statusCounts.confirmed + statusCounts.completed,
    bookedHours: round2(bookedHours),
    availableHours: round2(availableHours),
    utilisationPct: pct(bookedHours, availableHours),
    byLocation,
    byStaff,
    byDay: [...days].map(([date, d]) => ({
      date,
      bookings: d.bookings,
      bookedHours: round2(d.bookedHours),
    })),
    byWeekday: WEEKDAY_LABELS.map((label, weekday) => ({
      weekday,
      label,
      bookings: weekdays[weekday],
    })),
    byHour: hoursOfDay
      .map((bookings, hour) => ({
        hour,
        label: DateTime.fromObject({ hour }).toFormat("h a").toLowerCase(),
        bookings,
      }))
      .filter((h) => h.bookings > 0),
  };
}
