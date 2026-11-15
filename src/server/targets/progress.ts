import { DateTime } from "luxon";
import type { TargetMetric } from "./units";

export type TargetPeriod = "week" | "month";

export interface PeriodRange {
  period: TargetPeriod;
  /** Inclusive local dates. */
  from: string;
  to: string;
  label: string;
  days: number;
}

/** The Monday to Sunday week, or the calendar month, containing a local date (default: today). */
export function periodRange(
  period: TargetPeriod,
  timezone: string,
  now: Date,
  anchorDate?: string,
): PeriodRange {
  const anchor = anchorDate
    ? DateTime.fromISO(anchorDate, { zone: timezone })
    : DateTime.fromJSDate(now, { zone: timezone });
  const start = anchor.startOf(period === "week" ? "week" : "month");
  const end = anchor.endOf(period === "week" ? "week" : "month").startOf("day");
  return {
    period,
    from: start.toISODate() ?? "",
    to: end.toISODate() ?? "",
    label:
      period === "week"
        ? `${start.toFormat("d LLL")} to ${end.toFormat("d LLL yyyy")}`
        : start.toFormat("LLLL yyyy"),
    days: Math.round(end.diff(start, "days").days) + 1,
  };
}

/** The same kind of period, one step earlier or later. */
export function shiftAnchor(range: PeriodRange, steps: number): string {
  const from = DateTime.fromISO(range.from, { zone: "utc" });
  return (
    from.plus(range.period === "week" ? { weeks: steps } : { months: steps }).toISODate() ?? ""
  );
}

/** How far through the period we are (0 to 100), counting today as a whole day. */
export function elapsedPct(range: PeriodRange, timezone: string, now: Date): number {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const start = DateTime.fromISO(range.from, { zone: timezone });
  const done = Math.round(today.diff(start, "days").days) + 1;
  return Math.max(0, Math.min(100, Math.round((done / range.days) * 100)));
}

export function periodEnded(range: PeriodRange, timezone: string, now: Date): boolean {
  return (DateTime.fromJSDate(now, { zone: timezone }).toISODate() ?? "") > range.to;
}

export interface TargetLike {
  staffId: string | null;
  metric: TargetMetric;
  period: TargetPeriod;
  targetValue: number;
  validFrom: string;
  validTo: string | null;
}

/**
 * The target in force for a person (or the whole business when staffId is null), metric and period type:
 * its validity must overlap the period, and when several do the one that started most recently wins.
 */
export function pickTarget<T extends TargetLike>(
  targets: readonly T[],
  want: { staffId: string | null; metric: TargetMetric; range: PeriodRange },
): T | null {
  const matches = targets.filter(
    (t) =>
      t.staffId === want.staffId &&
      t.metric === want.metric &&
      t.period === want.range.period &&
      t.validFrom <= want.range.to &&
      (t.validTo === null || t.validTo >= want.range.from),
  );
  return matches.sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0] ?? null;
}

export type ProgressStatus = "met" | "on_pace" | "behind" | "missed" | "no_data";

export interface Progress {
  actual: number | null;
  target: number;
  /** actual / target as a whole percentage. Can exceed 100. Null with no data. */
  pct: number | null;
  /** pct limited to 0 to 100, for drawing the bar. */
  barPct: number;
  status: ProgressStatus;
}

/**
 * Progress towards a target. Higher is better for every metric. While the period is running, "on pace"
 * means at least as far along as the calendar is; once it has ended anything under 100% is "missed".
 * A null actual (a rate with nothing to measure) is "no data", never 0%.
 */
export function progressOf(
  actual: number | null,
  target: number,
  elapsed: number,
  ended: boolean,
): Progress {
  if (actual === null) return { actual, target, pct: null, barPct: 0, status: "no_data" };
  const pct = Math.round((actual / target) * 100);
  const status: ProgressStatus =
    pct >= 100 ? "met" : ended ? "missed" : pct >= elapsed ? "on_pace" : "behind";
  return { actual, target, pct, barPct: Math.max(0, Math.min(100, pct)), status };
}

export const PROGRESS_LABEL: Record<ProgressStatus, string> = {
  met: "Target met",
  on_pace: "On pace",
  behind: "Behind pace",
  missed: "Missed",
  no_data: "No data yet",
};
