"use server";

import { runAction } from "@/server/admin/action";
import {
  cancelStaffBooking,
  markBookingNoShow,
  refundBookingPayment,
  resendBookingConfirmation,
} from "@/server/admin/commands";
import type { ActionResult } from "@/server/admin/errors";
import { bookingIdSchema, cancelSchema, refundSchema } from "@/server/admin/schemas";
import { getCommandContext } from "@/server/admin/session";

export interface OutcomeView {
  depositAction: "refund" | "keep" | "none";
  feeCents: number;
}

export async function cancelBookingAction(raw: unknown): Promise<ActionResult<OutcomeView>> {
  return runAction("cancel booking", async () => {
    const ctx = await getCommandContext("booking.cancel");
    const outcome = await cancelStaffBooking(ctx, cancelSchema.parse(raw));
    return { depositAction: outcome.depositAction, feeCents: outcome.feeCents };
  });
}

export async function markNoShowAction(raw: unknown): Promise<ActionResult<OutcomeView>> {
  return runAction("mark no-show", async () => {
    const ctx = await getCommandContext("booking.edit");
    const outcome = await markBookingNoShow(ctx, bookingIdSchema.parse(raw));
    return { depositAction: outcome.depositAction, feeCents: outcome.feeCents };
  });
}

export async function resendConfirmationAction(raw: unknown): Promise<ActionResult> {
  return runAction("resend confirmation", async () => {
    const ctx = await getCommandContext("booking.edit");
    await resendBookingConfirmation(ctx, bookingIdSchema.parse(raw));
  });
}

export async function refundPaymentAction(raw: unknown): Promise<ActionResult> {
  return runAction("refund payment", async () => {
    const ctx = await getCommandContext("money.refund");
    await refundBookingPayment(ctx, refundSchema.parse(raw));
  });
}
