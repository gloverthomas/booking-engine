import { and, asc, eq, isNull } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import type { PaymentIntentResult } from "../contracts";
import type { Db } from "../db-types";
import {
  CURRENCY,
  PaymentError,
  getStripe,
  nowOf,
  type PaymentDeps,
  type StripeLike,
} from "./stripe";

type ClientRow = typeof client.$inferSelect;

async function ensureCustomer(db: Db, stripe: StripeLike, row: ClientRow): Promise<string> {
  if (row.stripeCustomerId) return row.stripeCustomerId;
  const name = `${row.firstName} ${row.lastName}`.trim();
  const customer = await stripe.customers.create(
    {
      name,
      ...(row.email ? { email: row.email } : {}),
      ...(row.phone ? { phone: row.phone } : {}),
      metadata: { clientId: row.id },
    },
    { idempotencyKey: `customer:${row.id}` },
  );
  // Only the first writer wins; the idempotency key makes a racing call return the same customer.
  await db
    .update(client)
    .set({ stripeCustomerId: customer.id })
    .where(and(eq(client.id, row.id), isNull(client.stripeCustomerId)));
  return customer.id;
}

/**
 * Start (or resume) the deposit payment for a held booking. Returns the PaymentIntent client secret
 * for Stripe Elements. Calling again for the same booking reuses the same PaymentIntent.
 */
export async function createDepositIntent(
  db: Db,
  bookingId: string,
  deps?: PaymentDeps,
): Promise<PaymentIntentResult> {
  const now = nowOf(deps);
  const [found] = await db
    .select({ booking, client })
    .from(booking)
    .innerJoin(client, eq(booking.clientId, client.id))
    .where(eq(booking.id, bookingId));
  if (!found) throw new PaymentError("booking_not_found", `Booking not found: ${bookingId}`);

  const { booking: b, client: c } = found;
  if (b.status !== "pending_payment") {
    throw new PaymentError(
      "booking_not_payable",
      `Booking ${bookingId} is ${b.status}, not awaiting payment`,
    );
  }
  if (!b.holdExpiresAt || b.holdExpiresAt.getTime() <= now.getTime()) {
    throw new PaymentError("hold_expired", `The hold on booking ${bookingId} has expired`);
  }
  if (b.depositCents <= 0) {
    throw new PaymentError("no_deposit_due", `Booking ${bookingId} has no deposit to pay`);
  }

  const stripe = getStripe(deps);
  const priorDeposits = await db
    .select()
    .from(payment)
    .where(and(eq(payment.bookingId, bookingId), eq(payment.kind, "deposit")))
    .orderBy(asc(payment.createdAt));

  if (priorDeposits.some((p) => p.status === "succeeded")) {
    throw new PaymentError("booking_not_payable", `Booking ${bookingId} deposit is already paid`);
  }

  // Resume the latest unpaid attempt unless Stripe has cancelled its intent.
  const resumable = priorDeposits.filter((p) => p.stripePaymentIntentId && p.status !== "refunded");
  const latest = resumable.at(-1);
  if (latest?.stripePaymentIntentId) {
    const intent = await stripe.paymentIntents.retrieve(latest.stripePaymentIntentId);
    if (intent.status !== "canceled" && intent.client_secret) {
      return {
        paymentId: latest.id,
        clientSecret: intent.client_secret,
        amountCents: latest.amountCents,
      };
    }
    await db.update(payment).set({ status: "failed" }).where(eq(payment.id, latest.id));
  }

  const customerId = await ensureCustomer(db, stripe, c);
  const attempt = priorDeposits.length;
  const intent = await stripe.paymentIntents.create(
    {
      amount: b.depositCents,
      currency: CURRENCY,
      customer: customerId,
      description: `Booking deposit ${bookingId}`,
      automatic_payment_methods: { enabled: true },
      // Saves the card on the customer so a late-cancel / no-show fee can be charged off-session.
      setup_future_usage: "off_session",
      metadata: { bookingId },
    },
    { idempotencyKey: attempt === 0 ? `deposit:${bookingId}` : `deposit:${bookingId}:${attempt}` },
  );
  if (!intent.client_secret) {
    throw new PaymentError(
      "stripe_error",
      "Stripe returned a PaymentIntent without a client secret",
    );
  }

  await db
    .insert(payment)
    .values({
      bookingId,
      kind: "deposit",
      method: "stripe_online",
      status: "pending",
      amountCents: b.depositCents,
      currency: CURRENCY,
      stripePaymentIntentId: intent.id,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(payment)
    .where(and(eq(payment.stripePaymentIntentId, intent.id), eq(payment.kind, "deposit")));

  return { paymentId: row.id, clientSecret: intent.client_secret, amountCents: b.depositCents };
}
