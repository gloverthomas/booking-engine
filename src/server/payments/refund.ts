import { eq } from "drizzle-orm";
import { payment } from "@/db/schema";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { listRefundsOf, lockPayment, sumCents } from "./ledger";
import { CURRENCY, PaymentError, getStripe, type PaymentDeps } from "./stripe";

const REFUNDABLE = new Set(["succeeded", "partially_refunded"]);
const STRIPE_METHODS = new Set(["stripe_online", "stripe_in_person"]);

/**
 * Refund up to the amount still unrefunded on a payment (all of it when `amountCents` is omitted).
 * Records a `refund` row linked by metadata.refundOf and updates the original's status.
 * Safe to replay: with nothing left to refund and no amount given it does nothing, and the Stripe
 * idempotency key is derived from the ledger state so a retry after a crash reuses the same refund.
 */
export async function refundPayment(
  db: Db,
  paymentId: string,
  amountCents?: number,
  deps?: PaymentDeps,
): Promise<void> {
  if (amountCents !== undefined && (!Number.isInteger(amountCents) || amountCents <= 0)) {
    throw new PaymentError(
      "invalid_amount",
      "Refund amount must be a positive whole number of cents",
    );
  }

  await db.transaction(async (tx) => {
    const original = await lockPayment(tx, paymentId);
    if (!original) throw new PaymentError("payment_not_found", `Payment not found: ${paymentId}`);
    if (original.kind === "refund" || !REFUNDABLE.has(original.status)) {
      if (original.status === "refunded" && amountCents === undefined) return;
      throw new PaymentError(
        "not_refundable",
        `Payment ${paymentId} (${original.kind}, ${original.status}) cannot be refunded`,
      );
    }

    const alreadyRefunded = sumCents(await listRefundsOf(tx, paymentId));
    const remaining = original.amountCents - alreadyRefunded;
    if (remaining <= 0) {
      if (amountCents === undefined) return;
      throw new PaymentError("invalid_amount", `Payment ${paymentId} is already fully refunded`);
    }
    const amount = amountCents ?? remaining;
    if (amount > remaining) {
      throw new PaymentError(
        "invalid_amount",
        `Cannot refund ${amount} cents: only ${remaining} cents remain on payment ${paymentId}`,
      );
    }

    let stripeRefundId: string | null = null;
    if (STRIPE_METHODS.has(original.method)) {
      if (!original.stripePaymentIntentId) {
        throw new PaymentError(
          "not_refundable",
          `Payment ${paymentId} has no Stripe PaymentIntent`,
        );
      }
      const refund = await getStripe(deps).refunds.create(
        {
          payment_intent: original.stripePaymentIntentId,
          amount,
          metadata: { paymentId, bookingId: original.bookingId ?? "" },
        },
        { idempotencyKey: `refund:${paymentId}:${alreadyRefunded}:${amount}` },
      );
      if (refund.status === "failed" || refund.status === "canceled") {
        throw new PaymentError("stripe_error", `Stripe refund ${refund.id} ${refund.status}`);
      }
      stripeRefundId = refund.id;
    }

    const [row] = await tx
      .insert(payment)
      .values({
        bookingId: original.bookingId,
        kind: "refund",
        method: original.method,
        status: "succeeded",
        amountCents: amount,
        currency: CURRENCY,
        stripeChargeId: original.stripeChargeId,
        stripeRefundId,
        metadata: { refundOf: paymentId },
      })
      .returning();

    await tx
      .update(payment)
      .set({
        status:
          alreadyRefunded + amount >= original.amountCents ? "refunded" : "partially_refunded",
      })
      .where(eq(payment.id, paymentId));
    await emitDomainEvent(tx, { type: "payment.refunded", paymentId: row.id });
  });
}
