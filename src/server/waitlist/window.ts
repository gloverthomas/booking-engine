import { DateTime } from "luxon";

/** The client's preferences, as stored on waitlist_entry. */
export interface EntryWindow {
  /** Local dates (YYYY-MM-DD), inclusive. */
  earliestDate: string;
  latestDate: string;
  /** 0 = Sunday ... 6 = Saturday. Null = any day. */
  weekdays: number[] | null;
  /** Local minutes after midnight the appointment may start within, inclusive. Null = any time. */
  fromMinute: number | null;
  toMinute: number | null;
}

export const MINUTES_PER_DAY = 1440;

/** Preset time-of-day windows the public form offers. Inclusive minutes after local midnight. */
export const TIME_OF_DAY = {
  any: null,
  morning: { fromMinute: 0, toMinute: 719 },
  afternoon: { fromMinute: 720, toMinute: 1439 },
} as const;

export type TimeOfDay = keyof typeof TIME_OF_DAY;

/** 0 = Sunday ... 6 = Saturday, matching availability_rule and waitlist_entry. */
export function localWeekday(date: Date, timezone: string): number {
  return DateTime.fromJSDate(date, { zone: timezone }).weekday % 7;
}

/** Minutes after local midnight. */
export function localMinuteOfDay(date: Date, timezone: string): number {
  const dt = DateTime.fromJSDate(date, { zone: timezone });
  return dt.hour * 60 + dt.minute;
}

/** Does an appointment starting at `start` fit what the person asked for? */
export function windowAcceptsStart(window: EntryWindow, start: Date, timezone: string): boolean {
  const day = DateTime.fromJSDate(start, { zone: timezone }).toISODate();
  if (!day || day < window.earliestDate || day > window.latestDate) return false;
  if (window.weekdays && !window.weekdays.includes(localWeekday(start, timezone))) return false;
  if (window.fromMinute !== null || window.toMinute !== null) {
    const minute = localMinuteOfDay(start, timezone);
    if (minute < (window.fromMinute ?? 0)) return false;
    if (minute > (window.toMinute ?? MINUTES_PER_DAY - 1)) return false;
  }
  return true;
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Any time", "Mornings", "Afternoons" or "9 am to 1:30 pm". */
export function describeTimeOfDay(window: Pick<EntryWindow, "fromMinute" | "toMinute">): string {
  const { fromMinute, toMinute } = window;
  if (fromMinute === null && toMinute === null) return "Any time";
  const from = fromMinute ?? 0;
  const to = toMinute ?? MINUTES_PER_DAY - 1;
  if (from === TIME_OF_DAY.morning.fromMinute && to === TIME_OF_DAY.morning.toMinute) {
    return "Mornings";
  }
  if (from === TIME_OF_DAY.afternoon.fromMinute && to === TIME_OF_DAY.afternoon.toMinute) {
    return "Afternoons";
  }
  return `${formatMinute(from)} to ${formatMinute(to)}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Any day" or "Mon, Wed, Fri" (Monday first). */
export function describeWeekdays(weekdays: number[] | null): string {
  if (!weekdays || weekdays.length === 0 || weekdays.length === 7) return "Any day";
  const ordered = [...weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return ordered.map((d) => DAY_NAMES[d]).join(", ");
}
