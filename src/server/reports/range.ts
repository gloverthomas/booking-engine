import { DateTime } from "luxon";

export type Granularity = "day" | "week" | "month";

/** Thrown for bad report input (invalid dates, absurd ranges). Callers turn it into a 400 / tool error. */
export class ReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportInputError";
  }
}

export const MAX_RANGE_DAYS = 731;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ResolvedRange {
  timezone: string;
  /** Inclusive local dates (YYYY-MM-DD) in the business timezone. */
  fromDate: string;
  toDate: string;
  /** Instant of local midnight at the start of fromDate. */
  start: Date;
  /** Instant of local midnight after toDate (exclusive upper bound). */
  endExclusive: Date;
}

function parseLocalDate(value: string, timezone: string, label: string): DateTime {
  if (!LOCAL_DATE.test(value)) throw new ReportInputError(`${label} must be a YYYY-MM-DD date`);
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) throw new ReportInputError(`${label} is not a real calendar date`);
  return parsed;
}

/** Turn inclusive local dates into an exact instant range, DST safe. */
export function resolveRange(timezone: string, from: string, to: string): ResolvedRange {
  const start = parseLocalDate(from, timezone, "from");
  const end = parseLocalDate(to, timezone, "to");
  if (end < start) throw new ReportInputError("to must not be before from");
  const days = Math.round(end.diff(start, "days").days) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ReportInputError(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  }
  return {
    timezone,
    fromDate: from,
    toDate: to,
    start: start.startOf("day").toJSDate(),
    endExclusive: end.plus({ days: 1 }).startOf("day").toJSDate(),
  };
}

/** The local calendar date (YYYY-MM-DD) of an instant in the business timezone. */
export function localDateOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate() ?? "";
}

function unitOf(granularity: Granularity): "day" | "week" | "month" {
  return granularity;
}

/** Local date of the start of the bucket (day, ISO week starting Monday, or month) containing the instant. */
export function bucketStart(instant: Date, granularity: Granularity, timezone: string): string {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return local.startOf(unitOf(granularity)).toISODate() ?? "";
}

/** Every bucket start overlapping the range, in order (so charts have no gaps). */
export function listBuckets(range: ResolvedRange, granularity: Granularity): string[] {
  const unit = unitOf(granularity);
  const last = DateTime.fromISO(range.toDate, { zone: range.timezone });
  let cursor = DateTime.fromISO(range.fromDate, { zone: range.timezone }).startOf(unit);
  const keys: string[] = [];
  while (cursor <= last) {
    keys.push(cursor.toISODate() ?? "");
    cursor = cursor.plus({ [`${unit}s`]: 1 });
  }
  return keys;
}

/** Every local date in the range, inclusive. */
export function eachLocalDate(range: ResolvedRange): string[] {
  return listBuckets(range, "day");
}

export function bucketLabel(key: string, granularity: Granularity): string {
  const d = DateTime.fromISO(key);
  if (granularity === "month") return d.toFormat("LLL yyyy");
  if (granularity === "week") return `Wk of ${d.toFormat("d LLL")}`;
  return d.toFormat("ccc d LLL");
}

export interface RangePreset {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** Quick ranges for the picker, relative to `now` in the business timezone. */
export function rangePresets(now: Date, timezone: string): RangePreset[] {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const iso = (d: DateTime) => d.toISODate() ?? "";
  const lastMonth = today.minus({ months: 1 });
  return [
    { id: "this_month", label: "This month", from: iso(today.startOf("month")), to: iso(today) },
    {
      id: "last_month",
      label: "Last month",
      from: iso(lastMonth.startOf("month")),
      to: iso(lastMonth.endOf("month")),
    },
    { id: "last_30", label: "Last 30 days", from: iso(today.minus({ days: 29 })), to: iso(today) },
    { id: "last_90", label: "Last 90 days", from: iso(today.minus({ days: 89 })), to: iso(today) },
    { id: "this_year", label: "This year", from: iso(today.startOf("year")), to: iso(today) },
  ];
}

/** Default range when the URL has none: month to date. */
export function defaultRange(now: Date, timezone: string): { from: string; to: string } {
  const [first] = rangePresets(now, timezone);
  return { from: first.from, to: first.to };
}
