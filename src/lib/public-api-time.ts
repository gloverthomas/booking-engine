/**
 * Calendar-date helpers shared by the public API and the booking UI. Dates are plain
 * `YYYY-MM-DD` strings in the business time zone; arithmetic runs on UTC midnights so
 * it can never be shifted by the viewer's own zone or by DST. No Luxon here: this file
 * ships to the browser.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * MS_PER_DAY);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return fromUtcMs(Date.UTC(y, m, 0));
}

export function addMonths(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number);
  return fromUtcMs(Date.UTC(y, m - 1 + months, 1));
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const dayHeadingFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

const monthHeadingFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

/** "Friday 20 November" */
export function formatDayHeading(date: string): string {
  return dayHeadingFmt.format(new Date(toUtcMs(date))).replace(",", "");
}

/** "November 2026" */
export function formatMonthHeading(date: string): string {
  return monthHeadingFmt.format(new Date(toUtcMs(date)));
}

/** "2:30 pm" in the given zone. */
export function formatClock(iso: string, timeZone: string): string {
  const text = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
  return text.replace(/\s?([ap])\.?m\.?/i, (_m, ap: string) => ` ${ap.toLowerCase()}m`);
}

/** Format an instant in the business time zone, e.g. "Friday 20 November, 2:30 pm". */
export function formatInstant(iso: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  })
    .format(new Date(iso))
    .replace(",", "");
  return `${day}, ${formatClock(iso, timeZone)}`;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDateOf(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}
