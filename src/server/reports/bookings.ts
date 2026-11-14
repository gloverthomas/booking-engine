import { and, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { availabilityRule, booking, location, timeBlock } from "@/db/schema";
import type { Db } from "../db-types";
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

export interface BookingsQuery {
  timezone: string;
  from: string;
  to: string;
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

/** Wall-clock minute-of-day on a local date as an instant (so DST days have their real length). */
function localMinute(day: DateTime, minute: number): number {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf("day").toMillis();
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60 }).toMillis();
}

const hoursOf = (ms: number): number => ms / 3_600_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (booked: number, available: number): number | null =>
  available > 0 ? Math.round((booked / available) * 1000) / 10 : null;

/** Available hours per location for the range: weekly rules (respecting valid_from / valid_to) minus time blocks. */
async function availableHoursByLocation(
  db: Db,
  range: ResolvedRange,
): Promise<Map<string, number>> {
  const [rules, blocks] = await Promise.all([
    db.select().from(availabilityRule),
    db
      .select({ staffId: timeBlock.staffId, during: timeBlock.during })
      .from(timeBlock)
      .where(
        and(
          sql`${timeBlock.during} && tstzrange(${range.start.toISOString()}::timestamptz, ${range.endExclusive.toISOString()}::timestamptz, '[)')`,
        ),
      ),
  ]);

  const blocksByStaff = new Map<string, Interval[]>();
  for (const b of blocks) {
    blocksByStaff.set(b.staffId, [
      ...(blocksByStaff.get(b.staffId) ?? []),
      { start: b.during.start.getTime(), end: b.during.end.getTime() },
    ]);
  }
  const mergedBlocks = new Map(
    [...blocksByStaff].map(([staffId, list]) => [staffId, mergeIntervals(list)]),
  );

  const hours = new Map<string, number>();
  for (const date of eachLocalDate(range)) {
    const day = DateTime.fromISO(date, { zone: range.timezone });
    const weekday = day.weekday % 7; // Luxon: Monday = 1 ... Sunday = 7; schema: Sunday = 0
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      if (rule.validFrom && date < rule.validFrom) continue;
      if (rule.validTo && date > rule.validTo) continue;
      const interval = {
        start: localMinute(day, rule.startMinute),
        end: localMinute(day, rule.endMinute),
      };
      const open =
        interval.end - interval.start - overlapMs(interval, mergedBlocks.get(rule.staffId) ?? []);
      hours.set(rule.locationId, (hours.get(rule.locationId) ?? 0) + hoursOf(Math.max(0, open)));
    }
  }
  return hours;
}

/** Booking volume, utilisation and busiest days/times for appointments starting in the range. */
export async function getBookingsReport(db: Db, query: BookingsQuery): Promise<BookingsReport> {
  const range = resolveRange(query.timezone, query.from, query.to);
  const [rows, locations, availableByLocation] = await Promise.all([
    db
      .select({
        status: booking.status,
        locationId: booking.locationId,
        during: booking.during,
      })
      .from(booking)
      .where(
        and(
          gte(sql`lower(${booking.during})`, range.start),
          lt(sql`lower(${booking.during})`, range.endExclusive),
        ),
      ),
    db.select({ id: location.id, name: location.name }).from(location),
    availableHoursByLocation(db, range),
  ]);

  const statusCounts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    BookingStatusName,
    number
  >;
  const days = new Map(eachLocalDate(range).map((d) => [d, { bookings: 0, bookedHours: 0 }]));
  const weekdays = new Array<number>(7).fill(0);
  const hoursOfDay = new Array<number>(24).fill(0);
  const perLocation = new Map<string, { bookings: number; bookedHours: number }>();

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
  const availableHours = [...availableByLocation.values()].reduce((s, h) => s + h, 0);

  return {
    range,
    statusCounts,
    bookedCount: statusCounts.confirmed + statusCounts.completed,
    bookedHours: round2(bookedHours),
    availableHours: round2(availableHours),
    utilisationPct: pct(bookedHours, availableHours),
    byLocation,
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
