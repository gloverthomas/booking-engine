import { DateTime } from "luxon";

/**
 * Pure availability maths: no database, no clock. Everything arrives as parameters so it can be
 * unit-tested exhaustively (DST, buffers, partial overlaps...).
 *
 * Weekly rule minutes are LOCAL wall-clock minutes in `timezone`. Slots are stepped in real elapsed
 * time from the window start, so a window that spans a daylight-saving change is the correct length.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface WeeklyRule {
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** Local dates (YYYY-MM-DD), inclusive. Null = open ended. */
  validFrom: string | null;
  validTo: string | null;
}

export interface Candidate {
  staffId: string;
  /** Total length of all selected services for this staff member. */
  durationMin: number;
  /** Padding after the appointment (the last service's buffer). Occupies the stylist, not the client. */
  bufferMin: number;
  rules: WeeklyRule[];
  /** Time blocks plus bookings that already occupy this staff member. */
  busy: Interval[];
}

export interface EngineInput {
  timezone: string;
  /** Local dates (YYYY-MM-DD), inclusive. */
  fromDate: string;
  toDate: string;
  now: Date;
  slotStepMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  candidates: Candidate[];
}

export interface RawSlot {
  staffId: string;
  start: Date;
  /** End of the appointment as the client sees it (excludes the buffer). */
  end: Date;
  /** End of the time the stylist is occupied (appointment plus buffer). Stored as booking.during.end. */
  occupiedEnd: Date;
}

const MINUTE_MS = 60_000;

function zoned(date: Date, timezone: string): DateTime {
  const dt = DateTime.fromJSDate(date, { zone: timezone });
  if (!dt.isValid) throw new Error(`Invalid timezone: ${timezone}`);
  return dt;
}

/** The local calendar date (YYYY-MM-DD) of an instant in the business timezone. */
export function localDate(date: Date, timezone: string): string {
  return zoned(date, timezone).toISODate() as string;
}

/** The instant at which the wall clock in `day`'s zone reads `minute` minutes past local midnight. */
export function wallClockInstant(day: DateTime, minute: number): DateTime {
  if (minute >= 1440) return day.startOf("day").plus({ days: 1 }).startOf("day");
  return day.startOf("day").set({ hour: Math.floor(minute / 60), minute: minute % 60 });
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

function ruleApplies(rule: WeeklyRule, weekday: number, isoDate: string): boolean {
  if (rule.weekday !== weekday) return false;
  if (rule.validFrom && isoDate < rule.validFrom) return false;
  if (rule.validTo && isoDate > rule.validTo) return false;
  return true;
}

/** Clamp the requested range to [today, today + maxAdvanceDays]. Returns null when nothing is left. */
function clampRange(input: EngineInput): { from: DateTime; to: DateTime } | null {
  const today = zoned(input.now, input.timezone).startOf("day");
  const requestedFrom = DateTime.fromISO(input.fromDate, { zone: input.timezone });
  const requestedTo = DateTime.fromISO(input.toDate, { zone: input.timezone });
  const latest = today.plus({ days: input.maxAdvanceDays });
  const from = requestedFrom < today ? today : requestedFrom;
  const to = requestedTo > latest ? latest : requestedTo;
  return from <= to ? { from, to } : null;
}

export function computeSlots(input: EngineInput): RawSlot[] {
  const range = clampRange(input);
  if (!range) return [];

  const stepMs = input.slotStepMin * MINUTE_MS;
  const earliest = input.now.getTime() + input.minNoticeMin * MINUTE_MS;
  const slots: RawSlot[] = [];

  for (let day = range.from; day <= range.to; day = day.plus({ days: 1 }).startOf("day")) {
    const isoDate = day.toISODate() as string;
    const weekday = day.weekday % 7; // Luxon: 1 = Monday ... 7 = Sunday

    for (const candidate of input.candidates) {
      const durationMs = candidate.durationMin * MINUTE_MS;
      const occupiedMs = (candidate.durationMin + candidate.bufferMin) * MINUTE_MS;
      const seen = new Set<number>();

      for (const rule of candidate.rules) {
        if (!ruleApplies(rule, weekday, isoDate)) continue;
        const windowStart = wallClockInstant(day, rule.startMinute).toMillis();
        const windowEnd = wallClockInstant(day, rule.endMinute).toMillis();

        for (let t = windowStart; t + durationMs <= windowEnd; t += stepMs) {
          if (seen.has(t) || t < earliest) continue;
          const occupied: Interval = { start: new Date(t), end: new Date(t + occupiedMs) };
          if (candidate.busy.some((busy) => overlaps(occupied, busy))) continue;
          seen.add(t);
          slots.push({
            staffId: candidate.staffId,
            start: occupied.start,
            end: new Date(t + durationMs),
            occupiedEnd: occupied.end,
          });
        }
      }
    }
  }

  const order = new Map(input.candidates.map((c, i) => [c.staffId, i]));
  return slots.sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      (order.get(a.staffId) ?? 0) - (order.get(b.staffId) ?? 0),
  );
}
