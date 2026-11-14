import type { PaymentIntentResult } from "../contracts";
import type { Db } from "../db-types";

/** OWNER: workstream C (payments). Replace these stubs; keep the signatures. */

export async function createDepositIntent(
  _db: Db,
  _bookingId: string,
): Promise<PaymentIntentResult> {
  throw new Error("createDepositIntent not implemented");
}

/** Refund up to the amount paid on a payment. Records a `refund` payment row. */
export async function refundPayment(
  _db: Db,
  _paymentId: string,
  _amountCents?: number,
): Promise<void> {
  throw new Error("refundPayment not implemented");
}

/** Charge the client's saved card off-session (no-show / late-cancel fee). */
export async function chargeSavedCard(
  _db: Db,
  _input: { bookingId: string; kind: "no_show_fee" | "late_cancel_fee"; amountCents: number },
): Promise<void> {
  throw new Error("chargeSavedCard not implemented");
}

/** Record a balance paid in person (cash / EFTPOS / other) at checkout. */
export async function recordManualPayment(
  _db: Db,
  _input: {
    bookingId: string;
    method: "cash" | "eftpos" | "other";
    amountCents: number;
    note?: string;
  },
): Promise<void> {
  throw new Error("recordManualPayment not implemented");
}
