import { DateTime } from "luxon";
import { TimesheetError } from "./errors";

const MS_PER_MINUTE = 60_000;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Minutes actually worked: elapsed time between two instants minus the unpaid break. Uses instants, so a
 * shift that crosses a daylight saving change is the right length (an hour shorter or longer on the wall clock).
 */
export function netMinutes(clockIn: Date, clockOut: Date, breakMinutes: number): number {
  const elapsed = Math.round((clockOut.getTime() - clockIn.getTime()) / MS_PER_MINUTE);
  return Math.max(0, elapsed - Math.max(0, breakMinutes));
}

export const minutesToHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

function parseDate(value: string, timezone: string): DateTime {
  if (!LOCAL_DATE.test(value)) throw new TimesheetError("bad_date", "Use a date like 2026-11-16.");
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) throw new TimesheetError("bad_date", "That is not a real calendar date.");
  return parsed;
}

/** The Monday (local date, YYYY-MM-DD) of the week containing a local date or an instant. */
export function weekStartOf(value: string | Date, timezone: string): string {
  const local =
    typeof value === "string"
      ? parseDate(value, timezone)
      : DateTime.fromJSDate(value, { zone: timezone });
  return local.startOf("week").toISODate() ?? "";
}

/** The seven local dates of the week starting on `weekStart` (a Monday). */
export function weekDates(weekStart: string): string[] {
  const first = DateTime.fromISO(weekStart, { zone: "utc" });
  return Array.from({ length: 7 }, (_, i) => first.plus({ days: i }).toISODate() ?? "");
}

/** Local midnight to local midnight, as instants. */
export function weekBounds(
  timezone: string,
  weekStart: string,
): { start: Date; endExclusive: Date } {
  const start = parseDate(weekStart, timezone).startOf("day");
  return {
    start: start.toJSDate(),
    endExclusive: start.plus({ days: 7 }).startOf("day").toJSDate(),
  };
}

/**
 * Parse a `datetime-local` value (YYYY-MM-DDTHH:mm, business wall-clock time) into an instant. For the one
 * ambiguous hour when clocks go back, the earlier instant is used.
 */
export function parseLocalDateTime(value: string, timezone: string): Date {
  if (!LOCAL_DATE_TIME.test(value)) {
    throw new TimesheetError("bad_time", "Use a date and time like 2026-11-16 09:00.");
  }
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) throw new TimesheetError("bad_time", "That is not a real date and time.");
  return parsed.toJSDate();
}

/** A local date and wall-clock time for a `datetime-local` input. */
export function toLocalInputValue(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat("yyyy-LL-dd'T'HH:mm");
}

/** "3h 10m", "45m", "2h", "-1h 30m". */
export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

/** Like formatDuration but with an explicit plus sign for gains, so a difference never relies on colour. */
export function formatSignedDuration(minutes: number): string {
  return minutes > 0 ? `+${formatDuration(minutes)}` : formatDuration(minutes);
}

/** "9:02 am" in the business time zone. */
export function formatClockTime(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat("h:mm a").toLowerCase();
}

/** "Mon 16 Nov" for a local date. */
export function formatDayLabel(date: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).toFormat("ccc d LLL");
}

/** "16 Nov to 22 Nov 2026" for the week starting on a Monday. */
export function formatWeekLabel(weekStart: string): string {
  const first = DateTime.fromISO(weekStart, { zone: "utc" });
  const last = first.plus({ days: 6 });
  return `${first.toFormat("d LLL")} to ${last.toFormat("d LLL yyyy")}`;
}
