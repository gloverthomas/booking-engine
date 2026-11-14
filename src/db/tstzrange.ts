import { customType } from "drizzle-orm/pg-core";

export interface TimeRange {
  start: Date;
  end: Date;
}

const OFFSET_ONLY_HOURS = /([+-]\d{2})$/;

/** Postgres prints offsets like "+00" or "+10:30"; make them ISO-8601 so Date can parse them. */
function parseTimestamp(raw: string): Date {
  const iso = raw
    .trim()
    .replace(/^"|"$/g, "")
    .replace(" ", "T")
    .replace(OFFSET_ONLY_HOURS, "$1:00");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot parse timestamp from range bound: ${raw}`);
  }
  return date;
}

export function formatRange({ start, end }: TimeRange): string {
  return `[${start.toISOString()},${end.toISOString()})`;
}

export function parseRange(value: string): TimeRange {
  const inner = value.slice(1, -1);
  const comma = inner.indexOf(",");
  if (comma === -1) throw new Error(`Cannot parse range: ${value}`);
  return {
    start: parseTimestamp(inner.slice(0, comma)),
    end: parseTimestamp(inner.slice(comma + 1)),
  };
}

/** `[start,end)` half-open timestamptz range, so back-to-back bookings never overlap. */
export const tstzrange = customType<{ data: TimeRange; driverData: string }>({
  dataType: () => "tstzrange",
  toDriver: formatRange,
  fromDriver: parseRange,
});
