import { eq } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import { recordAudit } from "../audit";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { listBookingPayments, netPaidCents } from "./ledger";
import { CURRENCY, PaymentError, getStripe, type PaymentDeps } from "./stripe";

const log = createLogger("payments");

const DECLINE_CODES = new Set(["authentication_required", "card_declined"]);

interface CardFailure {
  code: string;
  message: string;
  intentId: string | null;
}

/** A customer-side card failure (declined, needs authentication). Anything else is a real error. */
function asCardFailure(error: unknown): CardFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as {
    type?: unknown;
    code?: unknown;
    message?: unknown;
    payment_intent?: { id?: unknown } | null;
  };
  const code = typeof e.code === "string" ? e.code : "";
  if (e.type !== "StripeCardError" && !DECLINE_CODES.has(code)) return null;
  const intentId = typeof e.payment_intent?.id === "string" ? e.payment_intent.id : null;
  return {
    code: code || "card_error",
    message: typeof e.message === "string" ? e.message : "Card was not accepted",
    intentId,
  };
}

type FeeKind = "no_show_fee" | "late_cancel_fee";

/**
 * Charge the client's saved card off-session for a no-show or late-cancel fee.
 * A declined card or a card that needs authentication is recorded as a failed payment row plus an
 * audit entry (so the admin can follow up) and does NOT throw. Replays are no-ops: a fee that is
 * already pending or paid for the booking is never charged twice.
 */
export async function chargeSavedCard(
  db: Db,
  input: { bookingId: string; kind: FeeKind; amountCents: number },
  deps?: PaymentDeps,
): Promise<void> {
  const { bookingId, kind, amountCents } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PaymentError("invalid_amount", "Fee must be a positive whole number of cents");
  }

  await db.transaction(async (tx) => {
    // Serialise concurrent fee charges for one booking.
    const [row] = await tx
      .select({ id: booking.id, clientId: booking.clientId })
      .from(booking)
      .where(eq(booking.id, bookingId))
      .for("update");
    if (!row) throw new PaymentError("booking_not_found", `Booking not found: ${bookingId}`);

    const payments = await listBookingPayments(tx, bookingId);
    const sameKind = payments.filter((p) => p.kind === kind);
    if (sameKind.some((p) => p.status === "succeeded" || p.status === "pending")) return;

    const recordFailure = async (reason: string, intentId: string | null): Promise<void> => {
      await tx
        .insert(payment)
        .values({
          bookingId,
          kind,
          method: "stripe_online",
          status: "failed",
          amountCents,
          currency: CURRENCY,
          stripePaymentIntentId: intentId,
          note: reason,
          metadata: { failureReason: reason },
        })
        .onConflictDoNothing();
      await recordAudit(tx, {
        actor: "system",
        action: "payment.charge_failed",
        entityType: "booking",
        entityId: bookingId,
        data: { kind, amountCents, reason },
      });
      log({ event: "fee_charge_failed", bookingId, kind, amountCents, reason });
    };

    const [owner] = await tx.select().from(client).where(eq(client.id, row.clientId));
    const deposit = payments.find(
      (p) =>
        p.kind === "deposit" &&
        p.status !== "pending" &&
        p.status !== "failed" &&
        typeof p.metadata.paymentMethodId === "string",
    );
    const paymentMethod = deposit?.metadata.paymentMethodId;
    if (!owner?.stripeCustomerId || typeof paymentMethod !== "string") {
      await recordFailure("No saved card on file for this client", null);
      return;
    }

    const stripe = getStripe(deps);
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: CURRENCY,
          customer: owner.stripeCustomerId,
          payment_method: paymentMethod,
          off_session: true,
          confirm: true,
          description: `${kind === "no_show_fee" ? "No-show" : "Late cancellation"} fee, booking ${bookingId}`,
          metadata: { bookingId, kind },
        },
        { idempotencyKey: `fee:${bookingId}:${kind}:${sameKind.length}` },
      );
      if (intent.status === "requires_payment_method") {
        await recordFailure("Card was not accepted", intent.id);
        return;
      }
      const succeeded = intent.status === "succeeded";
      const [created] = await tx
        .insert(payment)
        .values({
          bookingId,
          kind,
          method: "stripe_online",
          status: succeeded ? "succeeded" : "pending",
          amountCents,
          currency: CURRENCY,
          stripePaymentIntentId: intent.id,
          metadata: { paymentMethodId: paymentMethod },
        })
        .returning();
      if (succeeded)
        await emitDomainEvent(tx, { type: "payment.succeeded", paymentId: created.id });
    } catch (error) {
      const failure = asCardFailure(error);
      if (!failure) throw error;
      await recordFailure(`${failure.code}: ${failure.message}`, failure.intentId);
    }
  });
}

/** Cash / EFTPOS / other received at the appointment. Rejects anything beyond the unpaid balance. */
export async function recordManualPayment(
  db: Db,
  input: {
    bookingId: string;
    method: "cash" | "eftpos" | "other";
    amountCents: number;
    note?: string;
  },
): Promise<void> {
  const { bookingId, method, amountCents, note } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PaymentError("invalid_amount", "Amount must be a positive whole number of cents");
  }
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(booking).where(eq(booking.id, bookingId)).for("update");
    if (!b) throw new PaymentError("booking_not_found", `Booking not found: ${bookingId}`);

    const balance = b.totalCents - netPaidCents(await listBookingPayments(tx, bookingId));
    if (amountCents > balance) {
      throw new PaymentError(
        "invalid_amount",
        `Payment of ${amountCents} cents exceeds the ${Math.max(balance, 0)} cents still owing`,
      );
    }
    const [row] = await tx
      .insert(payment)
      .values({
        bookingId,
        kind: "balance",
        method,
        status: "succeeded",
        amountCents,
        currency: CURRENCY,
        note: note ?? null,
      })
      .returning();
    await emitDomainEvent(tx, { type: "payment.succeeded", paymentId: row.id });
  });
}
