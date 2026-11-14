import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { domainEvent, payment } from "@/db/schema";
import { refundPayment } from "@/server/payments";
import { createFakeStripe, insertPayment, seedBooking } from "./helpers";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.client.close();
});

async function paidDeposit(overrides: Partial<typeof payment.$inferInsert> = {}) {
  const { booking } = await seedBooking(t.db);
  return insertPayment(t.db, {
    bookingId: booking.id,
    kind: "deposit",
    method: "stripe_online",
    status: "succeeded",
    amountCents: 4750,
    stripePaymentIntentId: "pi_dep",
    stripeChargeId: "ch_dep",
    ...overrides,
  });
}

const refundsOf = async () =>
  (await t.db.select().from(payment)).filter((p) => p.kind === "refund");

describe("refundPayment", () => {
  test("refunds the full amount: Stripe refund, refund row, original marked refunded, event emitted", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit();

    await refundPayment(t.db, dep.id, undefined, { stripe });

    expect(stripe.calls.refunds).toHaveLength(1);
    expect(stripe.calls.refunds[0].params).toMatchObject({
      payment_intent: "pi_dep",
      amount: 4750,
    });
    const [row] = await refundsOf();
    expect(row).toMatchObject({
      kind: "refund",
      status: "succeeded",
      amountCents: 4750,
      bookingId: dep.bookingId,
      metadata: { refundOf: dep.id },
    });
    expect(row.stripeRefundId).toMatch(/^re_/);
    const [original] = await t.db.select().from(payment).where(eq(payment.id, dep.id));
    expect(original.status).toBe("refunded");
    const events = await t.db.select().from(domainEvent);
    expect(events.map((e) => e.type)).toEqual(["payment.refunded"]);
    expect(events[0].payload).toEqual({ paymentId: row.id });
  });

  test("a partial refund leaves the original partially_refunded and allows a second partial", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit();

    await refundPayment(t.db, dep.id, 1000, { stripe });
    let [original] = await t.db.select().from(payment).where(eq(payment.id, dep.id));
    expect(original.status).toBe("partially_refunded");

    await refundPayment(t.db, dep.id, 3750, { stripe });
    [original] = await t.db.select().from(payment).where(eq(payment.id, dep.id));
    expect(original.status).toBe("refunded");
    expect(await refundsOf()).toHaveLength(2);
    expect(stripe.calls.refunds.map((r) => r.key)).toEqual([
      `refund:${dep.id}:0:1000`,
      `refund:${dep.id}:1000:3750`,
    ]);
  });

  test("refunding the remainder after a partial refund refunds only what is left", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit();
    await refundPayment(t.db, dep.id, 1000, { stripe });
    await refundPayment(t.db, dep.id, undefined, { stripe });
    expect(stripe.calls.refunds[1].params.amount).toBe(3750);
  });

  test("replaying a full refund does nothing", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit();
    await refundPayment(t.db, dep.id, undefined, { stripe });
    await refundPayment(t.db, dep.id, undefined, { stripe });
    expect(stripe.calls.refunds).toHaveLength(1);
    expect(await refundsOf()).toHaveLength(1);
  });

  test("rejects more than the remaining amount, and non-positive amounts", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit();
    await expect(refundPayment(t.db, dep.id, 4751, { stripe })).rejects.toMatchObject({
      code: "invalid_amount",
    });
    await expect(refundPayment(t.db, dep.id, 0, { stripe })).rejects.toMatchObject({
      code: "invalid_amount",
    });
    await expect(refundPayment(t.db, dep.id, 10.5, { stripe })).rejects.toMatchObject({
      code: "invalid_amount",
    });
    expect(stripe.calls.refunds).toHaveLength(0);
  });

  test("rejects an explicit amount on a payment that is already fully refunded", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit();
    await refundPayment(t.db, dep.id, undefined, { stripe });
    await expect(refundPayment(t.db, dep.id, 100, { stripe })).rejects.toMatchObject({
      code: "not_refundable",
    });
  });

  test("rejects unknown, unpaid and refund-kind payments", async () => {
    const stripe = createFakeStripe();
    await expect(
      refundPayment(t.db, "00000000-0000-4000-8000-000000000000", undefined, { stripe }),
    ).rejects.toMatchObject({ code: "payment_not_found" });

    const pending = await paidDeposit({ status: "pending" });
    await expect(refundPayment(t.db, pending.id, undefined, { stripe })).rejects.toMatchObject({
      code: "not_refundable",
    });
  });

  test("does not record a refund when Stripe reports it failed", async () => {
    const stripe = createFakeStripe();
    stripe.nextRefundStatus = "failed";
    const dep = await paidDeposit();
    await expect(refundPayment(t.db, dep.id, undefined, { stripe })).rejects.toMatchObject({
      code: "stripe_error",
    });
    expect(await refundsOf()).toHaveLength(0);
    const [original] = await t.db.select().from(payment).where(eq(payment.id, dep.id));
    expect(original.status).toBe("succeeded");
  });

  test("a Stripe payment without a PaymentIntent cannot be refunded", async () => {
    const dep = await paidDeposit({ stripePaymentIntentId: null });
    await expect(
      refundPayment(t.db, dep.id, undefined, { stripe: createFakeStripe() }),
    ).rejects.toMatchObject({ code: "not_refundable" });
  });

  test("a cash payment is refunded in the ledger without calling Stripe", async () => {
    const stripe = createFakeStripe();
    const dep = await paidDeposit({
      kind: "balance",
      method: "cash",
      stripePaymentIntentId: null,
      stripeChargeId: null,
    });
    await refundPayment(t.db, dep.id, 2000, { stripe });
    expect(stripe.calls.refunds).toHaveLength(0);
    const [row] = await refundsOf();
    expect(row).toMatchObject({ method: "cash", amountCents: 2000, stripeRefundId: null });
  });
});
