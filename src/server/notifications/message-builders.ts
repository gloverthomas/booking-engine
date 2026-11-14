import type {
  BookingCancelledProps,
  BookingConfirmationProps,
  BookingMovedProps,
  DepositOutcome,
  InvoiceEmailProps,
  OwnerAlertKind,
  OwnerAlertProps,
} from "@/emails";
import type { BookingContext } from "./booking-context";
import { formatMoney, longDate, longTime } from "./format";

/** The settings' policy text, or a sentence generated from the cancellation window. */
export function policyTextFor(ctx: BookingContext): string {
  const custom = ctx.settings.policyText.trim();
  if (custom) return custom;
  const hours = ctx.settings.cancelWindowHours;
  return hours > 0
    ? `Changes or cancellations within ${hours} hours of your appointment forfeit your deposit.`
    : "";
}

function appointment(ctx: BookingContext) {
  return {
    dateLabel: longDate(ctx.start, ctx.timezone),
    timeLabel: longTime(ctx.start, ctx.timezone),
    services: ctx.services.map((s) => ({ name: s.name, price: formatMoney(s.priceCents) })),
    totalLabel: formatMoney(ctx.totalCents),
  };
}

function base(ctx: BookingContext) {
  return {
    businessName: ctx.businessName,
    firstName: ctx.client.firstName,
    staffName: ctx.staffName,
  };
}

function place(ctx: BookingContext) {
  return {
    locationName: ctx.location.name,
    address: ctx.location.address,
    arrivalNote: ctx.location.arrivalNote ?? undefined,
  };
}

export function confirmationProps(
  ctx: BookingContext,
  manageUrl: string,
  hasCalendarFile: boolean,
): BookingConfirmationProps {
  return {
    ...base(ctx),
    ...appointment(ctx),
    ...place(ctx),
    depositPaidLabel: ctx.depositPaidCents > 0 ? formatMoney(ctx.depositPaidCents) : null,
    balanceDueLabel: formatMoney(ctx.balanceDueCents),
    policyText: policyTextFor(ctx),
    manageUrl,
    hasCalendarFile,
  };
}

export function movedProps(
  ctx: BookingContext,
  previousStart: Date,
  manageUrl: string,
  hasCalendarFile: boolean,
): BookingMovedProps {
  return {
    ...base(ctx),
    ...appointment(ctx),
    ...place(ctx),
    previousDateLabel: longDate(previousStart, ctx.timezone),
    previousTimeLabel: longTime(previousStart, ctx.timezone),
    manageUrl,
    policyText: policyTextFor(ctx),
    hasCalendarFile,
  };
}

export interface CancellationDetails {
  by: "client" | "staff";
  depositAction: DepositOutcome;
  feeCents: number;
}

/** A refund/keep only means something if a deposit was actually paid. */
export function effectiveOutcome(ctx: BookingContext, action: DepositOutcome): DepositOutcome {
  return ctx.depositPaidCents > 0 ? action : "none";
}

export function cancelledProps(
  ctx: BookingContext,
  details: CancellationDetails,
  rebookUrl: string,
): BookingCancelledProps {
  const { dateLabel, timeLabel, services } = appointment(ctx);
  return {
    ...base(ctx),
    dateLabel,
    timeLabel,
    services,
    locationName: ctx.location.name,
    cancelledBy: details.by,
    depositOutcome: effectiveOutcome(ctx, details.depositAction),
    depositLabel: ctx.depositPaidCents > 0 ? formatMoney(ctx.depositPaidCents) : null,
    feeLabel: details.feeCents > 0 ? formatMoney(details.feeCents) : null,
    policyText: policyTextFor(ctx),
    rebookUrl,
  };
}

export function invoiceProps(ctx: BookingContext, invoiceNumber: string): InvoiceEmailProps {
  return {
    ...base(ctx),
    invoiceNumber,
    dateLabel: longDate(ctx.start, ctx.timezone),
    timeLabel: longTime(ctx.start, ctx.timezone),
    totalLabel: formatMoney(ctx.totalCents),
  };
}

export function ownerAlertProps(
  ctx: BookingContext,
  kind: OwnerAlertKind,
  options: { previousStart?: Date; depositAction?: DepositOutcome } = {},
): OwnerAlertProps {
  const { dateLabel, timeLabel, services, totalLabel } = appointment(ctx);
  return {
    businessName: ctx.businessName,
    kind,
    clientName: `${ctx.client.firstName} ${ctx.client.lastName}`.trim(),
    clientPhone: ctx.client.phone,
    clientEmail: ctx.client.email,
    dateLabel,
    timeLabel,
    previousWhen: options.previousStart
      ? `${longDate(options.previousStart, ctx.timezone)}, ${longTime(options.previousStart, ctx.timezone)}`
      : null,
    services,
    totalLabel,
    locationName: ctx.location.name,
    depositLabel: ctx.depositPaidCents > 0 ? formatMoney(ctx.depositPaidCents) : null,
    depositOutcome:
      kind === "cancelled" && options.depositAction
        ? effectiveOutcome(ctx, options.depositAction)
        : null,
    comments: ctx.comments,
  };
}
