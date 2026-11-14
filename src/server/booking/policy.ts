import type { CancelOutcome, CancelledBy } from "../contracts";
import { percentOfCents } from "../pricing";
import type { BusinessSettings } from "../settings";

/** Pure cancellation-policy rules (plan section 7). No I/O so every branch is cheap to test. */

export type PolicySettings = Pick<
  BusinessSettings,
  "cancelWindowHours" | "extraFeePct" | "refundOutsideWindow"
>;

const HOUR_MS = 3_600_000;

export function hoursUntil(start: Date, now: Date): number {
  return (start.getTime() - now.getTime()) / HOUR_MS;
}

/** Inside the window = strictly fewer than `windowHours` before the start (exactly 24h is still free). */
export function isInsideCancelWindow(start: Date, now: Date, windowHours: number): boolean {
  return hoursUntil(start, now) < windowHours;
}

/** Extra fee charged to the saved card on a late cancel or no-show. */
export function lateFee(totalCents: number, extraFeePct: number): number {
  return percentOfCents(totalCents, extraFeePct);
}

export interface CancelDecisionInput {
  bookingStatus: "pending_payment" | "confirmed";
  by: CancelledBy;
  start: Date;
  now: Date;
  totalCents: number;
  settings: PolicySettings;
  /** Override the policy: always refund the deposit, no fee. */
  forceRefund?: boolean;
}

export function decideCancellation(input: CancelDecisionInput): Omit<CancelOutcome, "bookingId"> {
  const plainStatus = input.by === "client" ? "cancelled_by_client" : "cancelled_by_staff";

  // Nothing has been paid on a pending booking, so there is nothing to refund or keep.
  if (input.bookingStatus === "pending_payment") {
    return { status: plainStatus, depositAction: "none", feeCents: 0 };
  }
  if (input.by === "staff" || input.forceRefund) {
    return { status: plainStatus, depositAction: "refund", feeCents: 0 };
  }

  const { settings } = input;
  if (isInsideCancelWindow(input.start, input.now, settings.cancelWindowHours)) {
    return {
      status: "late_cancelled",
      depositAction: "keep",
      feeCents: lateFee(input.totalCents, settings.extraFeePct),
    };
  }
  return {
    status: "cancelled_by_client",
    depositAction: settings.refundOutsideWindow === "refund" ? "refund" : "none",
    feeCents: 0,
  };
}
