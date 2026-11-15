import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { booking, payment, webhookEvent } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { completeBooking, confirmBooking } from "../booking";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { listRefundsOf, lockPayment, netPaidCents, sumCents, type PaymentRow } from "./ledger";
import { CURRENCY, nowOf, type PaymentDeps, type StripeEventLike } from "./stripe";

const log = createLogger("payments");

const idOrObject = z.union([z.string(), z.object({ id: z.string() })]).nullish();
const idOf = (value: z.infer<typeof idOrObject>): string | null =>
  typeof value === "string" ? value : (value?.id ?? null);

const intentSchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  latest_charge: idOrObject,
  payment_method: idOrObject,
  metadata: z.record(z.string(), z.string()).default({}),
  last_payment_error: z
    .object({ message: z.string().nullish(), code: z.string().nullish() })
    .nullish(),
});

const chargeSchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  amount_refunded: z.number().int(),
  payment_intent: idOrObject,
});

const disputeSchema = z.object({
  id: z.string(),
  charge: idOrObject,
  amount: z.number().int().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
});

const FEE_KINDS = ["no_show_fee", "late_cancel_fee"] as const;
const uuid = z.string().uuid();

export type WebhookOutcome = "processed" | "duplicate";

interface Context {
  tx: Db;
  eventAt: Date;
  now: Date;
}

/**
 * Apply one verified Stripe event exactly once. The dedupe row, the state changes and the
 * `processedAt` stamp commit together, so a failure anywhere rolls the lot back and Stripe retries.
 */
export async function processStripeEvent(
  db: Db,
  event: StripeEventLike,
  deps?: PaymentDeps,
): Promise<WebhookOutcome> {
  const now = nowOf(deps);
  const eventAt = event.created ? new Date(event.created * 1000) : now;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEvent)
      .values({ provider: "stripe", eventId: event.id })
      .onConflictDoNothing()
      .returning({ id: webhookEvent.id });
    if (inserted.length === 0) {
      const [existing] = await tx
        .select()
        .from(webhookEvent)
        .where(and(eq(webhookEvent.provider, "stripe"), eq(webhookEvent.eventId, event.id)));
      if (existing?.processedAt) return "duplicate";
    }

    await dispatch({ tx, eventAt, now }, event);

    await tx
      .update(webhookEvent)
      .set({ processedAt: now })
      .where(and(eq(webhookEvent.provider, "stripe"), eq(webhookEvent.eventId, event.id)));
    return "processed";
  });
}

async function dispatch(ctx: Context, event: StripeEventLike): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded":
      return onIntentSucceeded(ctx, intentSchema.parse(event.data.object));
    case "payment_intent.payment_failed":
      return onIntentFailed(ctx, intentSchema.parse(event.data.object));
    case "charge.refunded":
      return onChargeRefunded(ctx, chargeSchema.parse(event.data.object));
    case "charge.dispute.created":
      return onDisputeCreated(ctx, disputeSchema.parse(event.data.object));
    default:
      log({ event: "stripe_event_ignored", type: event.type, id: event.id });
  }
}

async function findByIntent(tx: Db, intentId: string): Promise<PaymentRow | undefined> {
  const [row] = await tx
    .select()
    .from(payment)
    .where(and(eq(payment.stripePaymentIntentId, intentId), ne(payment.kind, "refund")));
  return row;
}

type Intent = z.infer<typeof intentSchema>;

/** A payment Stripe tells us about that we have no row for yet (e.g. an in-person payment). */
async function insertUnknownPayment(ctx: Context, intent: Intent): Promise<PaymentRow> {
  const parsedId = uuid.safeParse(intent.metadata.bookingId);
  let bookingId: string | null = null;
  if (parsedId.success) {
    const [found] = await ctx.tx
      .select({ id: booking.id })
      .from(booking)
      .where(eq(booking.id, parsedId.data));
    bookingId = found?.id ?? null;
  }
  const feeKind = FEE_KINDS.find((k) => k === intent.metadata.kind);
  const [row] = await ctx.tx
    .insert(payment)
    .values({
      bookingId,
      kind: feeKind ?? (bookingId ? "deposit" : "balance"),
      method: bookingId ? "stripe_online" : "stripe_in_person",
      status: "pending",
      amountCents: intent.amount,
      currency: CURRENCY,
      stripePaymentIntentId: intent.id,
    })
    .returning();
  return row;
}

async function onIntentSucceeded(ctx: Context, intent: Intent): Promise<void> {
  const row = (await findByIntent(ctx.tx, intent.id)) ?? (await insertUnknownPayment(ctx, intent));
  const chargeId = idOf(intent.latest_charge);
  const paymentMethodId = idOf(intent.payment_method);
  const metadata = { ...row.metadata, ...(paymentMethodId ? { paymentMethodId } : {}) };

  if (
    row.status === "succeeded" ||
    row.status === "partially_refunded" ||
    row.status === "refunded"
  ) {
    // Already recorded (e.g. an off-session fee that succeeded synchronously): just backfill ids.
    await ctx.tx
      .update(payment)
      .set({ stripeChargeId: row.stripeChargeId ?? chargeId, metadata })
      .where(eq(payment.id, row.id));
    return;
  }

  const succeeded = { status: "succeeded" as const, stripeChargeId: chargeId };

  if (row.kind !== "deposit" || !row.bookingId) {
    await ctx.tx
      .update(payment)
      .set({ ...succeeded, metadata })
      .where(eq(payment.id, row.id));
    // Unmatched (no booking) payments are stored and otherwise ignored.
    if (row.bookingId)
      await emitDomainEvent(ctx.tx, { type: "payment.succeeded", paymentId: row.id });
    if (row.bookingId && row.kind === "balance" && row.method === "stripe_in_person") {
      await closeIfSettled(ctx, row.bookingId);
    }
    return;
  }

  const [b] = await ctx.tx.select().from(booking).where(eq(booking.id, row.bookingId));
  const holdLapsed =
    b?.status === "pending_payment" &&
    b.holdExpiresAt !== null &&
    b.holdExpiresAt.getTime() <= ctx.eventAt.getTime();
  const otherDepositPaid =
    b !== undefined &&
    (
      await ctx.tx
        .select({ id: payment.id })
        .from(payment)
        .where(
          and(
            eq(payment.bookingId, b.id),
            eq(payment.kind, "deposit"),
            eq(payment.status, "succeeded"),
            ne(payment.id, row.id),
          ),
        )
    ).length > 0;

  let refundReason: string | null = null;
  if (!b) refundReason = "booking_missing";
  else if (b.status === "pending_payment") refundReason = holdLapsed ? "hold_expired" : null;
  else if (b.status === "confirmed" || b.status === "completed") {
    refundReason = otherDepositPaid ? "duplicate_deposit" : null;
  } else refundReason = `booking_${b.status}`;

  if (refundReason) {
    await ctx.tx
      .update(payment)
      .set({
        ...succeeded,
        metadata: { ...metadata, needsRefund: true, needsRefundReason: refundReason },
      })
      .where(eq(payment.id, row.id));
    await recordAudit(ctx.tx, {
      actor: "system",
      action: "payment.succeeded_needs_refund",
      entityType: "payment",
      entityId: row.id,
      data: { bookingId: row.bookingId, reason: refundReason, amountCents: row.amountCents },
    });
    log({ event: "payment_needs_refund", paymentId: row.id, reason: refundReason });
    return;
  }

  await ctx.tx
    .update(payment)
    .set({ ...succeeded, metadata })
    .where(eq(payment.id, row.id));
  if (b?.status === "pending_payment") await confirmBooking(ctx.tx, b.id, ctx.eventAt);
  await emitDomainEvent(ctx.tx, { type: "payment.succeeded", paymentId: row.id });
}

/**
 * A card tapped at the appointment settles the balance: finish the booking, as manual checkout does.
 * Done here (not by the phone) so a dropped connection after the tap cannot leave it open.
 */
async function closeIfSettled(ctx: Context, bookingId: string): Promise<void> {
  const [b] = await ctx.tx.select().from(booking).where(eq(booking.id, bookingId));
  if (!b || b.status !== "confirmed") return;
  const paid = netPaidCents(
    await ctx.tx.select().from(payment).where(eq(payment.bookingId, bookingId)),
  );
  if (paid < b.totalCents) return;
  await completeBooking(ctx.tx, bookingId, ctx.now, "system");
}

async function onIntentFailed(ctx: Context, intent: Intent): Promise<void> {
  const row = await findByIntent(ctx.tx, intent.id);
  if (!row) return;
  // Never downgrade money we already hold. A failed attempt on a reusable intent may still succeed later.
  if (row.status !== "pending" && row.status !== "failed") return;
  const reason =
    intent.last_payment_error?.message ?? intent.last_payment_error?.code ?? "Payment failed";
  await ctx.tx
    .update(payment)
    .set({ status: "failed", metadata: { ...row.metadata, failureReason: reason } })
    .where(eq(payment.id, row.id));
}

async function onChargeRefunded(ctx: Context, charge: z.infer<typeof chargeSchema>): Promise<void> {
  const intentId = idOf(charge.payment_intent);
  const original =
    (intentId ? await findByIntent(ctx.tx, intentId) : undefined) ??
    (
      await ctx.tx
        .select()
        .from(payment)
        .where(and(eq(payment.stripeChargeId, charge.id), ne(payment.kind, "refund")))
    )[0];
  if (!original) return;

  // Serialise with refundPayment, which holds this lock while it creates the Stripe refund.
  const locked = await lockPayment(ctx.tx, original.id);
  if (!locked) return;

  const recorded = sumCents(await listRefundsOf(ctx.tx, locked.id));
  const delta = charge.amount_refunded - recorded;
  if (delta > 0) {
    // A refund we did not initiate (Stripe dashboard).
    const [row] = await ctx.tx
      .insert(payment)
      .values({
        bookingId: locked.bookingId,
        kind: "refund",
        method: locked.method,
        status: "succeeded",
        amountCents: delta,
        currency: CURRENCY,
        stripeChargeId: charge.id,
        metadata: { refundOf: locked.id, source: "stripe_webhook" },
      })
      .returning();
    await emitDomainEvent(ctx.tx, { type: "payment.refunded", paymentId: row.id });
  }
  if (charge.amount_refunded > 0) {
    await ctx.tx
      .update(payment)
      .set({
        status: charge.amount_refunded >= locked.amountCents ? "refunded" : "partially_refunded",
      })
      .where(eq(payment.id, locked.id));
  }
}

async function onDisputeCreated(
  ctx: Context,
  dispute: z.infer<typeof disputeSchema>,
): Promise<void> {
  const chargeId = idOf(dispute.charge);
  const [row] = chargeId
    ? await ctx.tx
        .select()
        .from(payment)
        .where(and(eq(payment.stripeChargeId, chargeId), ne(payment.kind, "refund")))
    : [];
  const summary = {
    id: dispute.id,
    reason: dispute.reason ?? null,
    status: dispute.status ?? null,
    amountCents: dispute.amount ?? null,
    receivedAt: ctx.now.toISOString(),
  };
  if (row) {
    await ctx.tx
      .update(payment)
      .set({ metadata: { ...row.metadata, dispute: summary } })
      .where(eq(payment.id, row.id));
  }
  await recordAudit(ctx.tx, {
    actor: "system",
    action: "payment.dispute_created",
    entityType: row ? "payment" : "stripe_charge",
    entityId: row?.id ?? chargeId ?? dispute.id,
    data: { ...summary, bookingId: row?.bookingId ?? null },
  });
  log({ event: "stripe_dispute_created", disputeId: dispute.id, paymentId: row?.id ?? null });
}
