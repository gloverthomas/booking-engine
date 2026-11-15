import { and, eq } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import { getEnv } from "@/lib/env";
import type { Db } from "../db-types";
import { listBookingPayments, netPaidCents } from "./ledger";
import { CURRENCY, PaymentError, getStripe, type PaymentDeps } from "./stripe";

/** Intent states in which the card can still be presented. */
const COLLECTABLE = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/** The Stripe Terminal Location the app connects its Tap to Pay reader to. */
export function terminalLocationId(): string | null {
  return getEnv().STRIPE_TERMINAL_LOCATION_ID ?? null;
}

/**
 * A short-lived secret the Terminal SDK in the app uses to talk to Stripe as this account. Never stored.
 * Scoped to the salon's Location when one is configured.
 */
export async function createConnectionToken(deps?: PaymentDeps): Promise<{ secret: string }> {
  const location = terminalLocationId() ?? undefined;
  const token = await getStripe(deps).terminal.connectionTokens.create(
    location ? { location } : {},
  );
  return { secret: token.secret };
}

export interface InPersonPayment {
  paymentId: string;
  paymentIntentId: string;
  /** What the app hands to the Terminal SDK to collect the card. */
  clientSecret: string;
  amountCents: number;
}

/**
 * Open (or resume) a card-present payment for what is still owing on a booking.
 *
 * The payment row is created here, up front, as a pending `stripe_in_person` balance, so when Stripe's
 * webhook arrives it finds a row it already understands instead of guessing what an unknown intent is.
 * The amount comes from the server's own ledger, never from the phone.
 *
 * Safe to call again: a second tap on "Take payment" resumes the same intent while it can still be paid
 * and the amount has not changed; otherwise the old intent is cancelled and a fresh one opened.
 */
export async function startInPersonPayment(
  db: Db,
  bookingId: string,
  deps?: PaymentDeps,
): Promise<InPersonPayment> {
  const stripe = getStripe(deps);

  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(booking).where(eq(booking.id, bookingId)).for("update");
    if (!b) throw new PaymentError("booking_not_found", `Booking not found: ${bookingId}`);
    if (b.status !== "confirmed") {
      throw new PaymentError("booking_not_payable", `A ${b.status} booking cannot be paid for`);
    }

    const rows = await listBookingPayments(tx, bookingId);
    const owing = b.totalCents - netPaidCents(rows);
    if (owing <= 0) throw new PaymentError("nothing_owing", "Nothing is owing on this booking");

    const open = rows
      .filter(
        (r) =>
          r.method === "stripe_in_person" &&
          r.kind === "balance" &&
          (r.status === "pending" || r.status === "failed") &&
          r.stripePaymentIntentId,
      )
      .sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime());

    for (const row of open) {
      const intentId = row.stripePaymentIntentId as string;
      const intent = await stripe.paymentIntents.retrieve(intentId);
      if (intent.status === "succeeded") {
        // Paid, and Stripe's webhook has not reached us yet. Do not charge twice.
        throw new PaymentError(
          "booking_not_payable",
          "That payment has already gone through. Refresh the appointment in a moment.",
        );
      }
      if (COLLECTABLE.has(intent.status) && intent.amount === owing && intent.client_secret) {
        if (row.status === "failed") {
          await tx.update(payment).set({ status: "pending" }).where(eq(payment.id, row.id));
        }
        return {
          paymentId: row.id,
          paymentIntentId: intent.id,
          clientSecret: intent.client_secret,
          amountCents: owing,
        };
      }
      // The amount changed (a refund, a discount) or the intent is dead: retire it.
      if (COLLECTABLE.has(intent.status)) await stripe.paymentIntents.cancel(intent.id);
      await tx
        .update(payment)
        .set({
          status: "failed",
          metadata: { ...row.metadata, failureReason: "Replaced by a new payment attempt" },
        })
        .where(eq(payment.id, row.id));
    }

    const [owner] = await tx
      .select({ email: client.email })
      .from(client)
      .where(eq(client.id, b.clientId));
    const attempt = rows.filter((r) => r.method === "stripe_in_person").length;
    const intent = await stripe.paymentIntents.create(
      {
        amount: owing,
        currency: CURRENCY,
        // Tap to Pay and card readers only. The online payment methods are not valid for a card-present intent.
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        description: `Appointment balance, booking ${bookingId}`,
        metadata: { bookingId, kind: "balance", channel: "tap_to_pay" },
        ...(owner?.email ? { receipt_email: owner.email } : {}),
      },
      { idempotencyKey: `inperson:${bookingId}:${owing}:${attempt}` },
    );
    if (!intent.client_secret) {
      throw new PaymentError("stripe_error", "Stripe did not return a client secret");
    }

    const [created] = await tx
      .insert(payment)
      .values({
        bookingId,
        kind: "balance",
        method: "stripe_in_person",
        status: "pending",
        amountCents: owing,
        currency: CURRENCY,
        stripePaymentIntentId: intent.id,
        metadata: { channel: "tap_to_pay" },
      })
      .returning();
    return {
      paymentId: created.id,
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      amountCents: owing,
    };
  });
}

/** The state of one in-person payment, for the app to poll after the tap while the webhook catches up. */
export async function inPersonPaymentStatus(
  db: Db,
  bookingId: string,
  paymentId: string,
): Promise<{ status: string; bookingStatus: string; balanceDueCents: number }> {
  const [row] = await db
    .select()
    .from(payment)
    .where(and(eq(payment.id, paymentId), eq(payment.bookingId, bookingId)));
  if (!row) throw new PaymentError("payment_not_found", `Payment not found: ${paymentId}`);
  const [b] = await db.select().from(booking).where(eq(booking.id, bookingId));
  const rows = await listBookingPayments(db, bookingId);
  return {
    status: row.status,
    bookingStatus: b?.status ?? "unknown",
    balanceDueCents: Math.max((b?.totalCents ?? 0) - netPaidCents(rows), 0),
  };
}
