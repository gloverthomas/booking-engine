import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { auditLog, domainEvent, payment } from "@/db/schema";
import { chargeSavedCard, recordManualPayment } from "@/server/payments";
import { createFakeStripe, insertPayment, seedBooking } from "./helpers";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.client.close();
});

async function bookingWithSavedCard() {
  const seeded = await seedBooking(t.db, { stripeCustomerId: "cus_1" });
  await insertPayment(t.db, {
    bookingId: seeded.booking.id,
    kind: "deposit",
    method: "stripe_online",
    status: "succeeded",
    amountCents: 4750,
    stripePaymentIntentId: "pi_dep",
    metadata: { paymentMethodId: "pm_saved" },
  });
  return seeded;
}

const feeRows = async (kind: "late_cancel_fee" | "no_show_fee") =>
  (await t.db.select().from(payment)).filter((p) => p.kind === kind);

class FakeCardError extends Error {
  readonly type = "StripeCardError";
  constructor(
    readonly code: string,
    message: string,
    readonly payment_intent?: { id: string },
  ) {
    super(message);
  }
}

describe("chargeSavedCard", () => {
  test("charges the saved card off-session and records a succeeded fee", async () => {
    const stripe = createFakeStripe();
    stripe.nextIntentStatus = "succeeded";
    const { booking } = await bookingWithSavedCard();

    await chargeSavedCard(
      t.db,
      { bookingId: booking.id, kind: "no_show_fee", amountCents: 2000 },
      { stripe },
    );

    expect(stripe.calls.intents[0].params).toMatchObject({
      amount: 2000,
      currency: "aud",
      customer: "cus_1",
      payment_method: "pm_saved",
      off_session: true,
      confirm: true,
      metadata: { bookingId: booking.id, kind: "no_show_fee" },
    });
    const [row] = await feeRows("no_show_fee");
    expect(row).toMatchObject({ status: "succeeded", amountCents: 2000, method: "stripe_online" });
    const events = await t.db.select().from(domainEvent);
    expect(events.map((e) => e.type)).toEqual(["payment.succeeded"]);
  });

  test("a replay does not charge twice", async () => {
    const stripe = createFakeStripe();
    stripe.nextIntentStatus = "succeeded";
    const { booking } = await bookingWithSavedCard();
    const input = { bookingId: booking.id, kind: "late_cancel_fee", amountCents: 1500 } as const;

    await chargeSavedCard(t.db, input, { stripe });
    await chargeSavedCard(t.db, input, { stripe });

    expect(stripe.calls.intents).toHaveLength(1);
    expect(await feeRows("late_cancel_fee")).toHaveLength(1);
  });

  test("a charge still processing is stored pending and not repeated", async () => {
    const stripe = createFakeStripe();
    stripe.nextIntentStatus = "processing";
    const { booking } = await bookingWithSavedCard();
    const input = { bookingId: booking.id, kind: "no_show_fee", amountCents: 900 } as const;
    await chargeSavedCard(t.db, input, { stripe });
    await chargeSavedCard(t.db, input, { stripe });
    const rows = await feeRows("no_show_fee");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(await t.db.select().from(domainEvent)).toHaveLength(0);
  });

  test("records a failed row and an audit entry, without throwing, when authentication is required", async () => {
    const stripe = createFakeStripe();
    stripe.failNextIntent = new FakeCardError(
      "authentication_required",
      "Authentication required",
      { id: "pi_failed" },
    );
    const { booking } = await bookingWithSavedCard();

    await expect(
      chargeSavedCard(
        t.db,
        { bookingId: booking.id, kind: "no_show_fee", amountCents: 2000 },
        { stripe },
      ),
    ).resolves.toBeUndefined();

    const [row] = await feeRows("no_show_fee");
    expect(row).toMatchObject({ status: "failed", stripePaymentIntentId: "pi_failed" });
    expect(row.note).toContain("authentication_required");
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({
      actor: "system",
      action: "payment.charge_failed",
      entityId: booking.id,
    });
  });

  test("a declined card is recorded the same way, and an admin retry uses a fresh idempotency key", async () => {
    const stripe = createFakeStripe();
    stripe.failNextIntent = new FakeCardError("card_declined", "Your card was declined.");
    const { booking } = await bookingWithSavedCard();
    const input = { bookingId: booking.id, kind: "late_cancel_fee", amountCents: 1500 } as const;

    await chargeSavedCard(t.db, input, { stripe });
    expect((await feeRows("late_cancel_fee"))[0]).toMatchObject({ status: "failed" });

    stripe.nextIntentStatus = "succeeded";
    await chargeSavedCard(t.db, input, { stripe });
    expect(stripe.calls.intents.map((c) => c.key)).toEqual([
      `fee:${booking.id}:late_cancel_fee:0`,
      `fee:${booking.id}:late_cancel_fee:1`,
    ]);
    const rows = await feeRows("late_cancel_fee");
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
  });

  test("an intent that comes back requiring a payment method is recorded as failed", async () => {
    const stripe = createFakeStripe();
    stripe.nextIntentStatus = "requires_payment_method";
    const { booking } = await bookingWithSavedCard();
    await chargeSavedCard(
      t.db,
      { bookingId: booking.id, kind: "no_show_fee", amountCents: 500 },
      { stripe },
    );
    expect((await feeRows("no_show_fee"))[0].status).toBe("failed");
  });

  test("records a failure instead of throwing when there is no saved card", async () => {
    const stripe = createFakeStripe();
    const { booking } = await seedBooking(t.db);
    await chargeSavedCard(
      t.db,
      { bookingId: booking.id, kind: "no_show_fee", amountCents: 500 },
      { stripe },
    );
    expect(stripe.calls.intents).toHaveLength(0);
    const [row] = await feeRows("no_show_fee");
    expect(row.status).toBe("failed");
    expect(row.note).toContain("No saved card");
  });

  test("unexpected Stripe errors propagate so the job is retried, and leave nothing behind", async () => {
    const stripe = createFakeStripe();
    stripe.failNextIntent = new Error("network down");
    const { booking } = await bookingWithSavedCard();
    await expect(
      chargeSavedCard(
        t.db,
        { bookingId: booking.id, kind: "no_show_fee", amountCents: 500 },
        { stripe },
      ),
    ).rejects.toThrow("network down");
    expect(await feeRows("no_show_fee")).toHaveLength(0);
  });

  test("validates the amount and the booking", async () => {
    const stripe = createFakeStripe();
    await expect(
      chargeSavedCard(
        t.db,
        { bookingId: "00000000-0000-4000-8000-000000000000", kind: "no_show_fee", amountCents: 0 },
        { stripe },
      ),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      chargeSavedCard(
        t.db,
        {
          bookingId: "00000000-0000-4000-8000-000000000000",
          kind: "no_show_fee",
          amountCents: 100,
        },
        { stripe },
      ),
    ).rejects.toMatchObject({ code: "booking_not_found" });
  });
});

describe("recordManualPayment", () => {
  test("records a succeeded balance payment and emits payment.succeeded", async () => {
    const { booking } = await seedBooking(t.db);
    await recordManualPayment(t.db, {
      bookingId: booking.id,
      method: "cash",
      amountCents: 4750,
      note: "Paid in cash",
    });
    const [row] = await t.db.select().from(payment);
    expect(row).toMatchObject({
      kind: "balance",
      method: "cash",
      status: "succeeded",
      amountCents: 4750,
      note: "Paid in cash",
    });
    expect((await t.db.select().from(domainEvent)).map((e) => e.type)).toEqual([
      "payment.succeeded",
    ]);
  });

  test("allows the exact outstanding balance after a deposit and rejects overpayment", async () => {
    const { booking } = await bookingWithSavedCard();
    await expect(
      recordManualPayment(t.db, { bookingId: booking.id, method: "eftpos", amountCents: 4751 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await recordManualPayment(t.db, {
      bookingId: booking.id,
      method: "eftpos",
      amountCents: 4750,
    });
    await expect(
      recordManualPayment(t.db, { bookingId: booking.id, method: "cash", amountCents: 1 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  test("a refunded deposit puts the money back on the balance; fees never reduce it", async () => {
    const { booking } = await seedBooking(t.db, { totalCents: 10000 });
    const dep = await insertPayment(t.db, {
      bookingId: booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "partially_refunded",
      amountCents: 5000,
      stripePaymentIntentId: "pi_a",
    });
    await insertPayment(t.db, {
      bookingId: booking.id,
      kind: "refund",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 2000,
      metadata: { refundOf: dep.id },
    });
    await insertPayment(t.db, {
      bookingId: booking.id,
      kind: "no_show_fee",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 3000,
      stripePaymentIntentId: "pi_fee",
    });
    // paid 5000 - refunded 2000 = 3000, so 7000 is owing.
    await expect(
      recordManualPayment(t.db, { bookingId: booking.id, method: "cash", amountCents: 7001 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await recordManualPayment(t.db, { bookingId: booking.id, method: "cash", amountCents: 7000 });
    const [updated] = await t.db.select().from(payment).where(eq(payment.kind, "balance"));
    expect(updated.amountCents).toBe(7000);
  });

  test("validates the amount and the booking", async () => {
    await expect(
      recordManualPayment(t.db, {
        bookingId: "00000000-0000-4000-8000-000000000000",
        method: "cash",
        amountCents: -5,
      }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      recordManualPayment(t.db, {
        bookingId: "00000000-0000-4000-8000-000000000000",
        method: "cash",
        amountCents: 5,
      }),
    ).rejects.toMatchObject({ code: "booking_not_found" });
  });
});
