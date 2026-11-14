/**
 * Weekly-hours helpers. Pure and dependency-free so the same code runs in the browser editor and on the server.
 * Minutes are local to the business timezone (minutes since local midnight); weekday 0 = Sunday ... 6 = Saturday.
 */

export interface MinuteRange {
  startMinute: number;
  endMinute: number;
}

export interface WeekRule extends MinuteRange {
  weekday: number;
}

/** Seven entries indexed by weekday (0 = Sunday). */
export type Week = MinuteRange[][];

export const MINUTES_PER_DAY = 1440;

export const WEEKDAYS_MON_FIRST: ReadonlyArray<{ index: number; label: string; short: string }> = [
  { index: 1, label: "Monday", short: "Mon" },
  { index: 2, label: "Tuesday", short: "Tue" },
  { index: 3, label: "Wednesday", short: "Wed" },
  { index: 4, label: "Thursday", short: "Thu" },
  { index: 5, label: "Friday", short: "Fri" },
  { index: 6, label: "Saturday", short: "Sat" },
  { index: 0, label: "Sunday", short: "Sun" },
];

export function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** "09:30" -> 570. Accepts 00:00 to 24:00. Returns null for anything else. */
export function hhmmToMinutes(value: string): number | null {
  const match = HHMM.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59) return null;
  const total = h * 60 + m;
  return total <= MINUTES_PER_DAY ? total : null;
}

/** Returns a human-readable problem with one day's ranges, or null when they are valid. */
export function validateRanges(ranges: readonly MinuteRange[]): string | null {
  for (const range of ranges) {
    if (range.startMinute < 0) return "Times must be between 00:00 and 24:00.";
    if (range.endMinute > MINUTES_PER_DAY) return "Times must be between 00:00 and 24:00.";
    if (range.endMinute <= range.startMinute) return "Each range must finish after it starts.";
  }
  const sorted = [...ranges].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.startMinute < previous.endMinute) {
      return "Ranges on the same day must not overlap.";
    }
  }
  return null;
}

export function emptyWeek(): Week {
  return Array.from({ length: 7 }, () => []);
}

function sortRanges(ranges: readonly MinuteRange[]): MinuteRange[] {
  return ranges
    .map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute }))
    .sort((a, b) => a.startMinute - b.startMinute);
}

export function rulesToWeek(rules: readonly WeekRule[]): Week {
  const week = emptyWeek();
  for (const rule of rules) {
    week[rule.weekday]?.push({ startMinute: rule.startMinute, endMinute: rule.endMinute });
  }
  return week.map(sortRanges);
}

/** Flattens to rows ordered by weekday then start time. */
export function weekToRules(week: Week): WeekRule[] {
  return week.flatMap((ranges, weekday) =>
    sortRanges(ranges).map((range) => ({ weekday, ...range })),
  );
}

/** Returns a new week where every target day has a copy of the source day's ranges. */
export function copyDay(week: Week, from: number, to: readonly number[]): Week {
  const source = week[from] ?? [];
  return week.map((ranges, weekday) =>
    weekday !== from && to.includes(weekday)
      ? source.map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute }))
      : ranges,
  );
}
