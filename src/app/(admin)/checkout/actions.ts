"use server";

import { runAction } from "@/server/admin/action";
import { checkoutBooking } from "@/server/admin/commands";
import type { ActionResult } from "@/server/admin/errors";
import { checkoutSchema } from "@/server/admin/schemas";
import { getCommandContext } from "@/server/admin/session";

export interface CheckoutSummary {
  method: "cash" | "eftpos" | "other";
  totalCents: number;
  paidCents: number;
  balanceDueCents: number;
  cashDiscountCents: number;
  payableCents: number;
  recordedPayment: boolean;
}

export async function checkoutAction(raw: unknown): Promise<ActionResult<CheckoutSummary>> {
  const ctx = await getCommandContext();
  return runAction("check out", async () => checkoutBooking(ctx, checkoutSchema.parse(raw)));
}
