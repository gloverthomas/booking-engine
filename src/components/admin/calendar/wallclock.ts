import { DateTime } from "luxon";

/**
 * FullCalendar is run with timeZone "UTC", and we feed it the business-local wall clock time
 * expressed as if it were UTC. That gives correct Melbourne rendering (including daylight saving)
 * without a named-timezone plugin. These helpers convert both ways.
 */

/** Real instant -> Date whose UTC fields equal the local wall clock in `zone`. */
export function toWallClock(instant: Date, zone: string): Date {
  const local = DateTime.fromJSDate(instant, { zone });
  return new Date(
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
      local.millisecond,
    ),
  );
}

/** Date whose UTC fields are a local wall clock time in `zone` -> the real instant. */
export function fromWallClock(wall: Date, zone: string): Date {
  return DateTime.fromObject(
    {
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      second: wall.getUTCSeconds(),
      millisecond: wall.getUTCMilliseconds(),
    },
    { zone },
  ).toJSDate();
}

const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";

/** Value for <input type="datetime-local"> showing `instant` in the business zone. */
export function toWallClockInput(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat(INPUT_FORMAT);
}

/** Parse a <input type="datetime-local"> value as business-local time. Null when empty/invalid. */
export function fromWallClockInput(value: string, zone: string): Date | null {
  if (!value) return null;
  const parsed = DateTime.fromFormat(value, INPUT_FORMAT, { zone });
  return parsed.isValid ? parsed.toJSDate() : null;
}
