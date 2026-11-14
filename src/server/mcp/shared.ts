import { z } from "zod";
import { DateTime } from "luxon";
import { McpToolError } from "./errors";

export { formatAud as dollars } from "../reports/money";

export const idSchema = z.uuid().describe("Identifier (UUID) taken from another tool's result.");

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .describe("Calendar date in the business timezone, YYYY-MM-DD.");

export const whenSchema = z
  .string()
  .min(10)
  .max(40)
  .describe(
    "Date and time, ISO 8601. With an offset (2026-11-20T15:00:00+11:00) it is exact; without one " +
      "(2026-11-20T15:00) it is read in the business timezone.",
  );

export const centsSchema = z.number().int().positive().max(10_000_000);

/** Parse an ISO date-time; no offset means business-local time. */
export function parseWhen(value: string, timezone: string, field = "time"): Date {
  const dt = DateTime.fromISO(value, { zone: timezone });
  if (!dt.isValid) {
    throw new McpToolError("invalid_input", `${field} is not a valid ISO 8601 date and time.`);
  }
  return dt.toJSDate();
}

export interface WhenOut {
  utc: string;
  /** e.g. "Tue 3 Nov 2026, 10:00 am" in the business timezone. */
  local: string;
}

export function whenOut(date: Date, timezone: string): WhenOut {
  return {
    utc: date.toISOString(),
    local: DateTime.fromJSDate(date, { zone: timezone })
      .toFormat("ccc d LLL yyyy, h:mm a")
      .replace(/ (AM|PM)$/, (m) => m.toLowerCase()),
  };
}

export const localDateOfInstant = (date: Date, timezone: string): string =>
  DateTime.fromJSDate(date, { zone: timezone }).toISODate() ?? "";

export function todayLocal(now: Date, timezone: string): string {
  return localDateOfInstant(now, timezone);
}

export function addDaysLocal(date: string, days: number, timezone: string): string {
  return DateTime.fromISO(date, { zone: timezone }).plus({ days }).toISODate() ?? date;
}
