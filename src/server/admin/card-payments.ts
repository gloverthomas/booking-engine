import { recordAudit } from "../audit";
import { assertCan } from "./access";
import { loadAccessibleBooking, type CommandContext } from "./commands";
import {
  inPersonPaymentStatus,
  startInPersonPayment,
  type InPersonPayment,
} from "../payments/terminal";

/**
 * Open a Tap to Pay payment for what is owing on a booking. Same rule as manual checkout: you need the
 * `checkout` permission, and a stylist can only take payment for their own bookings.
 */
export async function startCardPayment(
  ctx: CommandContext,
  input: { bookingId: string },
): Promise<InPersonPayment> {
  assertCan(ctx.access, "checkout");
  await loadAccessibleBooking(ctx, input.bookingId);
  const payment = await startInPersonPayment(ctx.db, input.bookingId);
  await recordAudit(ctx.db, {
    actor: ctx.actor,
    action: "booking.card_payment_started",
    entityType: "booking",
    entityId: input.bookingId,
    data: { paymentId: payment.paymentId, amountCents: payment.amountCents },
  });
  return payment;
}

export async function cardPaymentStatus(
  ctx: CommandContext,
  input: { bookingId: string; paymentId: string },
) {
  assertCan(ctx.access, "checkout");
  await loadAccessibleBooking(ctx, input.bookingId);
  return inPersonPaymentStatus(ctx.db, input.bookingId, input.paymentId);
}
