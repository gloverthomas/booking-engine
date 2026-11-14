import type { BusinessSettings } from "@/server/settings";
import { formatAud } from "./public-api-money";
import type { CancellationInfo, CancelData, DepositOutcome } from "./public-api-types";

export interface PolicyInput {
  status: string;
  start: Date;
  now: Date;
  depositCents: number;
  settings: Pick<BusinessSettings, "cancelWindowHours" | "refundOutsideWindow">;
}

const HOUR_MS = 3_600_000;

/**
 * What happens to the deposit if the client cancels right now, and whether they may change the
 * booking online at all. Mirrors the rules in PLAN.md section 7; the domain core still makes the
 * final call when the action is submitted, this only drives what the page tells the client first.
 */
export function describeCancellation(input: PolicyInput): CancellationInfo {
  const { status, start, now, depositCents, settings } = input;
  const windowHours = settings.cancelWindowHours;
  const deadlineMs = start.getTime() - windowHours * HOUR_MS;
  const deadline = new Date(deadlineMs).toISOString();
  const withinWindow = now.getTime() >= deadlineMs;
  const base = { windowHours, deadline, withinWindow };

  if (status === "pending_payment") {
    return {
      ...base,
      canCancel: true,
      canReschedule: false,
      depositOutcome: "none",
      cancelMessage: "This booking hasn't been paid yet. Cancelling simply releases the time.",
      blockedReason: "Complete your deposit payment first, then you can change this booking.",
    };
  }

  if (status !== "confirmed") {
    return {
      ...base,
      canCancel: false,
      canReschedule: false,
      depositOutcome: "none",
      cancelMessage: "",
      blockedReason: closedReason(status),
    };
  }

  if (now.getTime() >= start.getTime()) {
    return {
      ...base,
      canCancel: false,
      canReschedule: false,
      depositOutcome: "none",
      cancelMessage: "",
      blockedReason: "This appointment has already started.",
    };
  }

  const deposit = formatAud(depositCents);
  if (withinWindow) {
    return {
      ...base,
      canCancel: true,
      canReschedule: false,
      depositOutcome: depositCents > 0 ? "keep" : "none",
      cancelMessage:
        depositCents > 0
          ? `This appointment is less than ${windowHours} hours away, so your ${deposit} deposit will not be refunded.`
          : `This appointment is less than ${windowHours} hours away.`,
      blockedReason: `Changes need ${windowHours} hours' notice. Please contact the salon to move this booking.`,
    };
  }

  const outcome = depositCents > 0 ? settings.refundOutsideWindow : "none";
  return {
    ...base,
    canCancel: true,
    canReschedule: true,
    depositOutcome: outcome,
    cancelMessage:
      outcome === "refund"
        ? `You're cancelling with more than ${windowHours} hours' notice, so your ${deposit} deposit will be refunded.`
        : outcome === "credit"
          ? `You're cancelling with more than ${windowHours} hours' notice, so your ${deposit} deposit will be kept as credit towards a future booking.`
          : `You're cancelling with more than ${windowHours} hours' notice. There's nothing to pay.`,
    blockedReason: null,
  };
}

function closedReason(status: string): string {
  switch (status) {
    case "cancelled_by_client":
    case "cancelled_by_staff":
    case "late_cancelled":
      return "This booking has been cancelled.";
    case "completed":
      return "This appointment is complete.";
    case "no_show":
      return "This appointment was marked as missed.";
    case "expired":
      return "This booking expired before the deposit was paid.";
    default:
      return "This booking can't be changed online.";
  }
}

/** Result copy shown after a client cancels. `predicted` is what the policy said before they confirmed. */
export function cancelResultMessage(
  depositAction: CancelData["depositAction"],
  predicted: DepositOutcome,
  depositCents: number,
  windowHours: number,
): string {
  const deposit = formatAud(depositCents);
  if (depositAction === "keep") {
    return `Your booking is cancelled. As it was inside our ${windowHours} hour window, the ${deposit} deposit isn't refunded.`;
  }
  if (depositAction === "refund") {
    return `Your booking is cancelled and your ${deposit} deposit is on its way back to your card. It can take 5 to 10 business days to appear.`;
  }
  if (predicted === "credit" && depositCents > 0) {
    return `Your booking is cancelled and your ${deposit} deposit is held as credit towards a future booking.`;
  }
  return "Your booking is cancelled.";
}
