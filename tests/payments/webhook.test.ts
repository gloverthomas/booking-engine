import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { auditLog, domainEvent, payment, webhookEvent } from "@/db/schema";
import { processStripeEvent } from "@/server/payments";
import { confirmBooking } from "@/server/booking";
import { FIXED_NOW, insertPayment, seedBooking, stripeEvent } from "./helpers";

vi.mock("@/server/booking", () => ({
  confirmBooking: vi.fn(async () => {}),
  expireHolds: vi.fn(async () => 0),
}));

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
const deps = { now: FIXED_NOW };
const eventTypes = async () => (await t.db.select().from(domainEvent)).map((e) => e.type);
const paymentById = async (id: string) =>
  (await t.db.select().from(payment).where(eq(payment.id, id)))[0];

beforeEach(async () => {
  vi.mocked(confirmBooking).mockClear();
  t = await createTestDb();
});
afterEach(async () => {
  await t.client.close();
});

async function pendingDeposit(options: Parameters<typeof seedBooking>[1] = {}) {
  const seeded = await seedBooking(t.db, options);
  const dep = await insertPayment(t.db, {
    bookingId: seeded.booking.id,
    kind: "deposit",
    method: "stripe_online",
    status: "pending",
    amountCents: 4750,
    stripePaymentIntentId: "pi_1",
  });
  return { ...seeded, dep };
}

const succeeded = (extra: Record<string, unknown> = {}) => ({
  id: "pi_1",
  amount: 4750,
  latest_charge: "ch_1",
  payment_method: "pm_1",
  metadata: {},
  ...extra,
});

describe("dedupe", () => {
  test("a replayed event returns duplicate and is not reprocessed", async () => {
    const { dep } = await pendingDeposit();
    const event = stripeEvent("evt_1", "payment_intent.succeeded", succeeded());

    expect(await processStripeEvent(t.db, event, deps)).toBe("processed");
    expect(await processStripeEvent(t.db, event, deps)).toBe("duplicate");

    expect(confirmBooking).toHaveBeenCalledTimes(1);
    expect(await eventTypes()).toEqual(["payment.succeeded"]);
    const [log] = await t.db.select().from(webhookEvent);
    expect(log).toMatchObject({ provider: "stripe", eventId: "evt_1" });
    expect(log.processedAt).not.toBeNull();
    expect((await paymentById(dep.id)).status).toBe("succeeded");
  });

  test("a failure rolls everything back, including the dedupe row, so Stripe can retry", async () => {
    const { dep } = await pendingDeposit();
    vi.mocked(confirmBooking).mockRejectedValueOnce(new Error("boom"));
    const event = stripeEvent("evt_2", "payment_intent.succeeded", succeeded());

    await expect(processStripeEvent(t.db, event, deps)).rejects.toThrow("boom");
    expect(await t.db.select().from(webhookEvent)).toHaveLength(0);
    expect((await paymentById(dep.id)).status).toBe("pending");

    expect(await processStripeEvent(t.db, event, deps)).toBe("processed");
    expect((await paymentById(dep.id)).status).toBe("succeeded");
  });

  test("an unhandled event type is recorded and ignored", async () => {
    expect(await processStripeEvent(t.db, stripeEvent("evt_x", "customer.created", {}), deps)).toBe(
      "processed",
    );
    expect(await t.db.select().from(webhookEvent)).toHaveLength(1);
  });
});

describe("payment_intent.succeeded", () => {
  test("marks the deposit succeeded, stores charge and card, confirms the booking, emits the event", async () => {
    const { dep, booking } = await pendingDeposit();

    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );

    const row = await paymentById(dep.id);
    expect(row).toMatchObject({ status: "succeeded", stripeChargeId: "ch_1" });
    expect(row.metadata).toMatchObject({ paymentMethodId: "pm_1" });
    expect(confirmBooking).toHaveBeenCalledWith(expect.anything(), booking.id, FIXED_NOW);
    expect(await eventTypes()).toEqual(["payment.succeeded"]);
  });

  test("accepts expanded charge and payment method objects", async () => {
    const { dep } = await pendingDeposit();
    await processStripeEvent(
      t.db,
      stripeEvent(
        "evt_1",
        "payment_intent.succeeded",
        succeeded({ latest_charge: { id: "ch_obj" }, payment_method: { id: "pm_obj" } }),
      ),
      deps,
    );
    const row = await paymentById(dep.id);
    expect(row.stripeChargeId).toBe("ch_obj");
    expect(row.metadata).toMatchObject({ paymentMethodId: "pm_obj" });
  });

  test("a success after the hold lapsed is recorded and flagged for refund, not confirmed", async () => {
    const { dep } = await pendingDeposit({ status: "expired" });

    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );

    const row = await paymentById(dep.id);
    expect(row.status).toBe("succeeded");
    expect(row.metadata).toMatchObject({ needsRefund: true, needsRefundReason: "booking_expired" });
    expect(confirmBooking).not.toHaveBeenCalled();
    expect(await eventTypes()).toEqual([]);
    const [audit] = await t.db.select().from(auditLog);
    expect(audit.action).toBe("payment.succeeded_needs_refund");
  });

  test("a hold that lapsed before the payment was made is flagged even if the sweeper has not run", async () => {
    const { dep } = await pendingDeposit({ holdMinutes: -5 });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );
    expect((await paymentById(dep.id)).metadata).toMatchObject({
      needsRefund: true,
      needsRefundReason: "hold_expired",
    });
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  test("a delayed webhook for a payment made inside the hold still confirms", async () => {
    const { dep } = await pendingDeposit({ holdMinutes: 10 });
    // The webhook is processed 30 minutes after the hold, but Stripe stamped the event inside it.
    const late = { now: new Date(FIXED_NOW.getTime() + 30 * 60_000) };
    const created = Math.floor(FIXED_NOW.getTime() / 1000);
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded(), created),
      late,
    );
    expect((await paymentById(dep.id)).status).toBe("succeeded");
    expect(confirmBooking).toHaveBeenCalledTimes(1);
  });

  test("a second deposit for an already confirmed booking is flagged as a duplicate", async () => {
    const seeded = await seedBooking(t.db, { status: "confirmed" });
    await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      stripePaymentIntentId: "pi_first",
    });
    const dup = await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "pending",
      amountCents: 4750,
      stripePaymentIntentId: "pi_1",
    });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );
    expect((await paymentById(dup.id)).metadata).toMatchObject({
      needsRefund: true,
      needsRefundReason: "duplicate_deposit",
    });
  });

  test("a first deposit on a booking staff already confirmed is recorded without confirming again", async () => {
    const { dep } = await pendingDeposit({ status: "confirmed" });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("succeeded");
    expect(confirmBooking).not.toHaveBeenCalled();
    expect(await eventTypes()).toEqual(["payment.succeeded"]);
  });

  test("an off-session fee that already succeeded only gets its charge id backfilled", async () => {
    const seeded = await seedBooking(t.db);
    const fee = await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "no_show_fee",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 2000,
      stripePaymentIntentId: "pi_1",
    });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );
    expect((await paymentById(fee.id)).stripeChargeId).toBe("ch_1");
    expect(confirmBooking).not.toHaveBeenCalled();
    expect(await eventTypes()).toEqual([]);
  });

  test("a pending fee that completes is marked succeeded and announced, without confirming the booking", async () => {
    const seeded = await seedBooking(t.db);
    const fee = await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "late_cancel_fee",
      method: "stripe_online",
      status: "pending",
      amountCents: 2000,
      stripePaymentIntentId: "pi_1",
    });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded()),
      deps,
    );
    expect((await paymentById(fee.id)).status).toBe("succeeded");
    expect(confirmBooking).not.toHaveBeenCalled();
    expect(await eventTypes()).toEqual(["payment.succeeded"]);
  });

  test("a payment without a bookingId is stored with a null booking and otherwise ignored", async () => {
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.succeeded", succeeded({ amount: 3000 })),
      deps,
    );
    const [row] = await t.db.select().from(payment);
    expect(row).toMatchObject({
      bookingId: null,
      status: "succeeded",
      amountCents: 3000,
      method: "stripe_in_person",
      stripePaymentIntentId: "pi_1",
    });
    expect(confirmBooking).not.toHaveBeenCalled();
    expect(await eventTypes()).toEqual([]);
  });

  test("an unknown intent that names a real booking is stored as that booking's deposit and confirms it", async () => {
    const seeded = await seedBooking(t.db);
    await processStripeEvent(
      t.db,
      stripeEvent(
        "evt_1",
        "payment_intent.succeeded",
        succeeded({ metadata: { bookingId: seeded.booking.id } }),
      ),
      deps,
    );
    const [row] = await t.db.select().from(payment);
    expect(row).toMatchObject({
      kind: "deposit",
      bookingId: seeded.booking.id,
      status: "succeeded",
    });
    expect(confirmBooking).toHaveBeenCalledTimes(1);
  });

  test("a bookingId that does not exist or is not a uuid is treated as no booking", async () => {
    await processStripeEvent(
      t.db,
      stripeEvent(
        "evt_1",
        "payment_intent.succeeded",
        succeeded({ metadata: { bookingId: "00000000-0000-4000-8000-000000000000" } }),
      ),
      deps,
    );
    await processStripeEvent(
      t.db,
      stripeEvent(
        "evt_2",
        "payment_intent.succeeded",
        succeeded({ id: "pi_2", metadata: { bookingId: "nonsense" } }),
      ),
      deps,
    );
    const rows = await t.db.select().from(payment);
    expect(rows.map((r) => r.bookingId)).toEqual([null, null]);
  });

  test("an unknown intent that names a fee kind is stored as that fee", async () => {
    const seeded = await seedBooking(t.db);
    await processStripeEvent(
      t.db,
      stripeEvent(
        "evt_1",
        "payment_intent.succeeded",
        succeeded({ metadata: { bookingId: seeded.booking.id, kind: "no_show_fee" } }),
      ),
      deps,
    );
    const [row] = await t.db.select().from(payment);
    expect(row.kind).toBe("no_show_fee");
    expect(confirmBooking).not.toHaveBeenCalled();
  });
});

describe("payment_intent.payment_failed", () => {
  test("marks a pending deposit failed with the reason, leaving the booking alone", async () => {
    const { dep } = await pendingDeposit();
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.payment_failed", {
        id: "pi_1",
        amount: 4750,
        metadata: {},
        last_payment_error: { message: "Your card was declined.", code: "card_declined" },
      }),
      deps,
    );
    const row = await paymentById(dep.id);
    expect(row.status).toBe("failed");
    expect(row.metadata).toMatchObject({ failureReason: "Your card was declined." });
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  test("never downgrades a succeeded payment, and ignores unknown intents", async () => {
    const { dep } = await pendingDeposit();
    await t.db.update(payment).set({ status: "succeeded" }).where(eq(payment.id, dep.id));
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.payment_failed", {
        id: "pi_1",
        amount: 1,
        metadata: {},
      }),
      deps,
    );
    await processStripeEvent(
      t.db,
      stripeEvent("evt_2", "payment_intent.payment_failed", { id: "pi_nope", amount: 1 }),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("succeeded");
  });

  test("a failed attempt can still succeed later on the same intent", async () => {
    const { dep } = await pendingDeposit();
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "payment_intent.payment_failed", { id: "pi_1", amount: 4750 }),
      deps,
    );
    expect((await paymentById(dep.id)).metadata).toMatchObject({ failureReason: "Payment failed" });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_2", "payment_intent.succeeded", succeeded()),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("succeeded");
    expect(confirmBooking).toHaveBeenCalledTimes(1);
  });
});

describe("charge.refunded", () => {
  async function paidDeposit() {
    const { dep, booking } = await pendingDeposit();
    await t.db
      .update(payment)
      .set({ status: "succeeded", stripeChargeId: "ch_1" })
      .where(eq(payment.id, dep.id));
    return { dep, booking };
  }

  test("a refund made in the Stripe dashboard creates a refund row and marks the payment refunded", async () => {
    const { dep } = await paidDeposit();
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.refunded", {
        id: "ch_1",
        amount: 4750,
        amount_refunded: 4750,
        payment_intent: "pi_1",
      }),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("refunded");
    const refunds = (await t.db.select().from(payment)).filter((p) => p.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amountCents: 4750,
      metadata: { refundOf: dep.id, source: "stripe_webhook" },
    });
    expect(await eventTypes()).toEqual(["payment.refunded"]);
  });

  test("a partial refund is partially_refunded; the next event only records the new amount", async () => {
    const { dep } = await paidDeposit();
    const charge = { id: "ch_1", amount: 4750, payment_intent: "pi_1" };
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.refunded", { ...charge, amount_refunded: 1000 }),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("partially_refunded");
    await processStripeEvent(
      t.db,
      stripeEvent("evt_2", "charge.refunded", { ...charge, amount_refunded: 4750 }),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("refunded");
    const amounts = (await t.db.select().from(payment))
      .filter((p) => p.kind === "refund")
      .map((p) => p.amountCents)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([1000, 3750]);
  });

  test("does not double count a refund we already recorded ourselves", async () => {
    const { dep, booking } = await paidDeposit();
    await insertPayment(t.db, {
      bookingId: booking.id,
      kind: "refund",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      metadata: { refundOf: dep.id },
    });
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.refunded", {
        id: "ch_1",
        amount: 4750,
        amount_refunded: 4750,
        payment_intent: "pi_1",
      }),
      deps,
    );
    expect((await t.db.select().from(payment)).filter((p) => p.kind === "refund")).toHaveLength(1);
    expect((await paymentById(dep.id)).status).toBe("refunded");
    expect(await eventTypes()).toEqual([]);
  });

  test("finds the payment by charge id when the event has no intent, and ignores unknown charges", async () => {
    const { dep } = await paidDeposit();
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.refunded", { id: "ch_1", amount: 4750, amount_refunded: 500 }),
      deps,
    );
    expect((await paymentById(dep.id)).status).toBe("partially_refunded");
    await processStripeEvent(
      t.db,
      stripeEvent("evt_2", "charge.refunded", { id: "ch_unknown", amount: 1, amount_refunded: 1 }),
      deps,
    );
    expect(await t.db.select().from(payment)).toHaveLength(2);
  });
});

describe("charge.dispute.created", () => {
  test("marks the payment, and audits", async () => {
    const { dep } = await pendingDeposit();
    await t.db.update(payment).set({ stripeChargeId: "ch_1" }).where(eq(payment.id, dep.id));
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.dispute.created", {
        id: "dp_1",
        charge: "ch_1",
        amount: 4750,
        reason: "fraudulent",
        status: "needs_response",
      }),
      deps,
    );
    expect((await paymentById(dep.id)).metadata).toMatchObject({
      dispute: { id: "dp_1", reason: "fraudulent", status: "needs_response", amountCents: 4750 },
    });
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({
      action: "payment.dispute_created",
      entityType: "payment",
      entityId: dep.id,
    });
  });

  test("audits a dispute on a charge we have no payment for", async () => {
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.dispute.created", { id: "dp_1", charge: "ch_unknown" }),
      deps,
    );
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ entityType: "stripe_charge", entityId: "ch_unknown" });
  });

  test("handles a dispute with no charge reference", async () => {
    await processStripeEvent(
      t.db,
      stripeEvent("evt_1", "charge.dispute.created", { id: "dp_1" }),
      deps,
    );
    const [audit] = await t.db.select().from(auditLog);
    expect(audit.entityId).toBe("dp_1");
  });
});
