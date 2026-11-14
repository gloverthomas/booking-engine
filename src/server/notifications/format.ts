import { DateTime } from "luxon";

const LOCALE = "en-AU";

function local(date: Date, timeZone: string): DateTime {
  const dt = DateTime.fromJSDate(date, { zone: timeZone }).setLocale(LOCALE);
  if (!dt.isValid) throw new Error(`Cannot format date ${date.toISOString()} in ${timeZone}`);
  return dt;
}

/** "Sat, 14 Nov" (SMS) */
export function shortDate(date: Date, timeZone: string): string {
  return local(date, timeZone).toFormat("ccc, d LLL");
}

/** "2:15PM" (SMS) */
export function shortTime(date: Date, timeZone: string): string {
  return local(date, timeZone).toFormat("h:mma").toUpperCase();
}

/** "Saturday 14 November 2026" (email) */
export function longDate(date: Date, timeZone: string): string {
  return local(date, timeZone).toFormat("cccc d LLLL yyyy");
}

/** "2:15 PM" (email) */
export function longTime(date: Date, timeZone: string): string {
  return local(date, timeZone).toFormat("h:mm a").toUpperCase();
}

/** "$95.00" */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
