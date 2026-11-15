import { DateTime } from "luxon";
import type { BadgeTone } from "@/components/ui";

/** "Mon 2 Nov, 10:00 am" in the business zone. */
export function whenLabel(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone })
    .setLocale("en-AU")
    .toFormat("ccc d LLL, h:mm a")
    .replace(/\s?([AP]M)$/i, (_m, ap: string) => ` ${ap.toLowerCase()}`);
}

/** "Mon 2 Nov" from a YYYY-MM-DD date. */
export function dayLabel(date: string): string {
  return DateTime.fromISO(date).setLocale("en-AU").toFormat("ccc d LLL");
}

/** "3 days", "5 hours", "just now". */
export function ageLabel(created: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 60_000));
  if (minutes < 60) return minutes < 2 ? "just now" : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

export const STATUS_TONE: Record<string, BadgeTone> = {
  waiting: "info",
  offered: "warning",
  booked: "success",
  expired: "neutral",
  cancelled: "neutral",
  sent: "warning",
  claimed: "success",
  slot_taken: "neutral",
};

export const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting",
  offered: "Offered",
  booked: "Booked",
  expired: "Expired",
  cancelled: "Removed",
  sent: "Sent",
  claimed: "Claimed",
  slot_taken: "Taken",
};
