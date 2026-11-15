import { DateTime } from "luxon";

/** The columns of availability_rule that matter here. */
export interface RuleLike {
  locationId: string;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  startMinute: number;
  endMinute: number;
  validFrom: string | null;
  validTo: string | null;
}

/** The columns of roster_exception that matter here. */
export interface ExceptionLike {
  locationId: string | null;
  /** Local date, YYYY-MM-DD. */
  date: string;
  kind: "off" | "custom";
  startMinute: number | null;
  endMinute: number | null;
}

/** A block of rostered wall-clock time on one local day. */
export interface RosterSegment {
  /** Null only for a custom day set "everywhere" on a day that had no weekly rule. */
  locationId: string | null;
  startMinute: number;
  endMinute: number;
}

/** A rostered block as exact instants (epoch milliseconds), so daylight saving days have their real length. */
export interface RosterInterval {
  locationId: string | null;
  start: number;
  end: number;
}

/** Luxon: Monday = 1 ... Sunday = 7. The schema: Sunday = 0. */
function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: "utc" }).weekday % 7;
}

/**
 * What one person is rostered to work on one local date: the weekly rules that apply (respecting valid_from
 * and valid_to), changed by that day's exceptions. `off` removes a location (or everything when it has no
 * location); `custom` replaces that location's rules for the day (or the whole day when it has no location).
 * Pass only one person's rules and exceptions.
 */
export function rosterSegmentsForDay(
  rules: readonly RuleLike[],
  exceptions: readonly ExceptionLike[],
  date: string,
): RosterSegment[] {
  const weekday = weekdayOf(date);
  const dayExceptions = exceptions.filter((e) => e.date === date);
  if (dayExceptions.some((e) => e.kind === "off" && e.locationId === null)) return [];

  let base: RosterSegment[] = rules
    .filter(
      (r) =>
        r.weekday === weekday &&
        (r.validFrom === null || date >= r.validFrom) &&
        (r.validTo === null || date <= r.validTo),
    )
    .map((r) => ({ locationId: r.locationId, startMinute: r.startMinute, endMinute: r.endMinute }));

  const offLocations = new Set(
    dayExceptions.flatMap((e) => (e.kind === "off" && e.locationId ? [e.locationId] : [])),
  );
  base = base.filter((s) => s.locationId === null || !offLocations.has(s.locationId));

  const customs = dayExceptions.filter(
    (e) => e.kind === "custom" && e.startMinute !== null && e.endMinute !== null,
  );
  const replaced = new Set(customs.flatMap((e) => (e.locationId ? [e.locationId] : [])));
  const replacesAll = customs.some((e) => e.locationId === null);
  const fallbackLocation =
    [...base].sort((a, b) => a.startMinute - b.startMinute)[0]?.locationId ?? null;

  const kept = replacesAll
    ? []
    : base.filter((s) => s.locationId === null || !replaced.has(s.locationId));
  const added = customs.map((e) => ({
    locationId: e.locationId ?? fallbackLocation,
    startMinute: e.startMinute ?? 0,
    endMinute: e.endMinute ?? 0,
  }));
  return [...kept, ...added];
}

/** Wall-clock minute-of-day on a local day as an instant. Minute 1440 is the next local midnight. */
export function localMinuteInstant(day: DateTime, minute: number): number {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf("day").toMillis();
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60 }).toMillis();
}

export function rosterIntervalsForDay(
  rules: readonly RuleLike[],
  exceptions: readonly ExceptionLike[],
  date: string,
  timezone: string,
): RosterInterval[] {
  const day = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  return rosterSegmentsForDay(rules, exceptions, date).map((s) => ({
    locationId: s.locationId,
    start: localMinuteInstant(day, s.startMinute),
    end: localMinuteInstant(day, s.endMinute),
  }));
}

/** Total length of the union of intervals (overlaps counted once), in milliseconds. */
export function unionMs(intervals: ReadonlyArray<{ start: number; end: number }>): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const interval of sorted) {
    const start = Math.max(interval.start, cursor);
    if (interval.end > start) total += interval.end - start;
    cursor = Math.max(cursor, interval.end);
  }
  return total;
}

/** Minutes the person is rostered on that local date, overlaps counted once, daylight saving safe. */
export function rosteredMinutesForDay(
  rules: readonly RuleLike[],
  exceptions: readonly ExceptionLike[],
  date: string,
  timezone: string,
): number {
  return Math.round(unionMs(rosterIntervalsForDay(rules, exceptions, date, timezone)) / 60_000);
}
