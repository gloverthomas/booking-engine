/** Pure checkout arithmetic. No server imports so client components can use it for live previews. */

export type ManualPaymentMethod = "cash" | "eftpos" | "other";

export interface CheckoutBookingTotals {
  totalCents: number;
  /** Net paid so far (payments minus refunds). */
  paidCents: number;
}

export interface CheckoutAmounts {
  totalCents: number;
  paidCents: number;
  balanceDueCents: number;
  cashDiscountCents: number;
  payableCents: number;
}

export function computeCheckout(
  booking: CheckoutBookingTotals,
  settings: { cashDiscountPct: number },
  method: ManualPaymentMethod,
): CheckoutAmounts {
  const balanceDueCents = Math.max(0, booking.totalCents - booking.paidCents);
  const rawDiscount =
    method === "cash" ? Math.round((balanceDueCents * settings.cashDiscountPct) / 100) : 0;
  const cashDiscountCents = Math.min(balanceDueCents, Math.max(0, rawDiscount));
  return {
    totalCents: booking.totalCents,
    paidCents: booking.paidCents,
    balanceDueCents,
    cashDiscountCents,
    payableCents: Math.max(0, balanceDueCents - cashDiscountCents),
  };
}
