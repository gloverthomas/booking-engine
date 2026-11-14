import {
  addDays,
  addMonths,
  compareDates,
  monthEnd,
  monthStart,
  weekdayOf,
} from "@/lib/public-api-time";

export interface DayCell {
  date: string;
  /** Day of month, 1-31. */
  day: number;
  /** Has at least one bookable time. */
  available: boolean;
  /** Cannot be chosen (no times, before today, or beyond the booking horizon). */
  disabled: boolean;
  isToday: boolean;
}

/** Weeks start on Monday, the Australian convention. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Monday = 0 ... Sunday = 6 */
function mondayIndex(date: string): number {
  return (weekdayOf(date) + 6) % 7;
}

export interface MonthGridInput {
  /** Any date inside the month to render. */
  month: string;
  availableDates: ReadonlySet<string>;
  today: string;
  /** Last bookable date (inclusive). */
  maxDate: string;
}

/** Rows of 7 cells; `null` pads days that belong to neighbouring months. */
export function buildMonthGrid(input: MonthGridInput): Array<Array<DayCell | null>> {
  const first = monthStart(input.month);
  const last = monthEnd(input.month);
  const cells: Array<DayCell | null> = Array.from({ length: mondayIndex(first) }, () => null);

  for (let date = first; compareDates(date, last) <= 0; date = addDays(date, 1)) {
    const inRange = compareDates(date, input.today) >= 0 && compareDates(date, input.maxDate) <= 0;
    const available = inRange && input.availableDates.has(date);
    cells.push({
      date,
      day: Number(date.slice(8, 10)),
      available,
      disabled: !available,
      isToday: date === input.today,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: Array<Array<DayCell | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function canGoPrevMonth(month: string, today: string): boolean {
  return compareDates(monthStart(month), monthStart(today)) > 0;
}

export function canGoNextMonth(month: string, maxDate: string): boolean {
  return compareDates(addMonths(month, 1), maxDate) <= 0;
}

/** First available date on or after `from`, or null. */
export function firstAvailable(dates: Iterable<string>, from: string): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (compareDates(d, from) >= 0 && (best === null || compareDates(d, best) < 0)) best = d;
  }
  return best;
}
