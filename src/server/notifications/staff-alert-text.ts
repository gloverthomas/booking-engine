import type { StaffAlertKind } from "@/emails";
import type { BookingContext } from "./booking-context";
import { longDate, longTime, shortDate, shortTime } from "./format";

const SMS_LEAD: Record<StaffAlertKind, string> = {
  new: "New booking",
  moved: "Booking moved",
  assigned: "Booking assigned to you",
  moved_away: "Booking moved away from you",
  cancelled: "Booking cancelled",
};

function servicesText(ctx: BookingContext): string {
  return ctx.services.map((s) => s.name).join(", ");
}

/**
 * One short SMS for the stylist. Client first name, services, local date/time and location only:
 * never the client's phone or email. `at` is the time to show (the lost slot for "moved_away").
 */
export function staffAlertSms(ctx: BookingContext, kind: StaffAlertKind, at: Date): string {
  const when = `${shortDate(at, ctx.timezone)} ${shortTime(at, ctx.timezone)}`;
  const place = [ctx.location.name, ctx.location.address].filter(Boolean).join(" ");
  return `${SMS_LEAD[kind]}: ${ctx.client.firstName}, ${servicesText(ctx)}, ${when}, ${place}.`;
}

/** The email props' display fields for a given moment. */
export function staffAlertWhen(
  ctx: BookingContext,
  at: Date,
): { dateLabel: string; timeLabel: string } {
  return { dateLabel: longDate(at, ctx.timezone), timeLabel: longTime(at, ctx.timezone) };
}

export function staffServiceNames(ctx: BookingContext): string[] {
  return ctx.services.map((s) => s.name);
}
