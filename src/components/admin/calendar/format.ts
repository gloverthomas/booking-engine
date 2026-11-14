import { DateTime } from "luxon";
import type { BookingStatus, PaymentKind, PaymentMethod } from "@/server/admin/types";

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

export function formatMoney(cents: number): string {
  return AUD.format(cents / 100);
}

function local(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(zone);
}

/** "Sat 14 Nov" */
export function formatDay(iso: string, zone: string): string {
  return local(iso, zone).toFormat("ccc d LLL");
}

/** "11:00 am" */
export function formatTime(iso: string, zone: string): string {
  return local(iso, zone).toFormat("h:mm a").toLowerCase();
}

/** "Sat 14 Nov, 11:00 am" */
export function formatDateTime(iso: string, zone: string): string {
  return `${formatDay(iso, zone)}, ${formatTime(iso, zone)}`;
}

/** "11:00 am to 11:45 am" (day shown separately). */
export function formatTimeRange(startIso: string, endIso: string, zone: string): string {
  return `${formatTime(startIso, zone)} to ${formatTime(endIso, zone)}`;
}

export const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: "Awaiting deposit",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled_by_client: "Cancelled by client",
  cancelled_by_staff: "Cancelled by you",
  late_cancelled: "Late cancellation",
  no_show: "No-show",
  expired: "Expired",
};

export type StatusTone = "neutral" | "good" | "warn" | "bad" | "info";

export const STATUS_TONE: Record<BookingStatus, StatusTone> = {
  pending_payment: "warn",
  confirmed: "info",
  completed: "good",
  cancelled_by_client: "neutral",
  cancelled_by_staff: "neutral",
  late_cancelled: "bad",
  no_show: "bad",
  expired: "neutral",
};

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  deposit: "Deposit",
  balance: "Balance",
  no_show_fee: "No-show fee",
  late_cancel_fee: "Late cancellation fee",
  refund: "Refund",
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  stripe_online: "Card (online)",
  stripe_in_person: "Card (in person)",
  cash: "Cash",
  eftpos: "EFTPOS",
  other: "Other",
};

/** Turn an audit action like "booking.rescheduled_by_staff" into "Rescheduled by staff". */
export function describeAuditAction(action: string): string {
  const tail = action.split(".").slice(1).join(" ") || action;
  const text = tail.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeActor(actor: string): string {
  if (actor.startsWith("owner:")) return "You";
  if (actor === "client") return "Client";
  if (actor === "mcp") return "Claude";
  return "System";
}
