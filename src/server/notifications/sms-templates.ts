import { shortDate, shortTime } from "./format";
import type { BookingContext } from "./booking-context";

export interface SmsVars {
  ctx: BookingContext;
  manageUrl: string;
}

function where(ctx: BookingContext): string {
  return [ctx.location.name, ctx.location.address].filter(Boolean).join(" ");
}

function when(ctx: BookingContext): { date: string; time: string } {
  return { date: shortDate(ctx.start, ctx.timezone), time: shortTime(ctx.start, ctx.timezone) };
}

/** "Hi Sam, your appointment with Ryan Kennedy is booked for Sat, 14 Nov at 2:15PM at Northside 12 Smith St. Manage: <link>" */
export function smsConfirmation({ ctx, manageUrl }: SmsVars): string {
  const { date, time } = when(ctx);
  return `Hi ${ctx.client.firstName}, your appointment with ${ctx.staffName} is booked for ${date} at ${time} at ${where(ctx)}. Manage: ${manageUrl}`;
}

/** Day-before reminder, modelled on Timely's wording. */
export function smsReminder({ ctx, manageUrl }: SmsVars): string {
  const { date, time } = when(ctx);
  const note = ctx.location.arrivalNote ? ` ${ctx.location.arrivalNote}` : "";
  return `Hi ${ctx.client.firstName}, this is a friendly reminder of your appointment with ${ctx.staffName} on ${date} at ${time} at ${where(ctx)}.${note} ${manageUrl}`;
}

export function smsMoved({ ctx, manageUrl }: SmsVars): string {
  const { date, time } = when(ctx);
  return `Hi ${ctx.client.firstName}, your appointment with ${ctx.staffName} has been moved to ${date} at ${time} at ${where(ctx)}. Manage: ${manageUrl}`;
}

export type CancelOutcome = "refund" | "keep" | "none";

export function smsCancelled(
  ctx: BookingContext,
  outcome: CancelOutcome,
  rebookUrl: string,
): string {
  const { date, time } = when(ctx);
  const deposit =
    outcome === "refund" && ctx.depositPaidCents > 0
      ? " Your deposit is being refunded."
      : outcome === "keep" && ctx.depositPaidCents > 0
        ? " Your deposit is not refundable under our cancellation policy."
        : "";
  return `Hi ${ctx.client.firstName}, your appointment with ${ctx.staffName} on ${date} at ${time} has been cancelled.${deposit} Rebook: ${rebookUrl}`;
}
