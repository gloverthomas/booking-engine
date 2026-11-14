import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { client, payment } from "@/db/schema";
import { createDepositIntent } from "@/server/payments";
import { PaymentError } from "@/server/payments/stripe";
import { FIXED_NOW, createFakeStripe, insertPayment, seedBooking } from "./helpers";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.client.close();
});

describe("createDepositIntent", () => {
  test("creates a customer and an off-session-saving PaymentIntent for the deposit", async () => {
    const stripe = createFakeStripe();
    const { booking, cl } = await seedBooking(t.db);

    const result = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });

    expect(result.amountCents).toBe(4750);
    expect(result.clientSecret).toMatch(/_secret$/);
    const [call] = stripe.calls.intents;
    expect(call.key).toBe(`deposit:${booking.id}`);
    expect(call.params).toMatchObject({
      amount: 4750,
      currency: "aud",
      setup_future_usage: "off_session",
      automatic_payment_methods: { enabled: true },
      metadata: { bookingId: booking.id },
    });
    const [updated] = await t.db.select().from(client).where(eq(client.id, cl.id));
    expect(updated.stripeCustomerId).toBe(call.params.customer);
    const [row] = await t.db.select().from(payment).where(eq(payment.id, result.paymentId));
    expect(row).toMatchObject({
      kind: "deposit",
      method: "stripe_online",
      status: "pending",
      amountCents: 4750,
      bookingId: booking.id,
    });
  });

  test("reuses the existing Stripe customer", async () => {
    const stripe = createFakeStripe();
    const { booking } = await seedBooking(t.db, { stripeCustomerId: "cus_existing" });
    await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });
    expect(stripe.calls.customers).toHaveLength(0);
    expect(stripe.calls.intents[0].params.customer).toBe("cus_existing");
  });

  test("a second call reuses the pending intent instead of creating another", async () => {
    const stripe = createFakeStripe();
    const { booking } = await seedBooking(t.db);
    const first = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });
    const second = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });

    expect(second).toEqual(first);
    expect(stripe.calls.intents).toHaveLength(1);
    expect(await t.db.select().from(payment)).toHaveLength(1);
  });

  test("creates a fresh intent when Stripe has cancelled the previous one", async () => {
    const stripe = createFakeStripe();
    const { booking } = await seedBooking(t.db);
    const first = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });
    const [old] = await t.db.select().from(payment).where(eq(payment.id, first.paymentId));
    stripe.intentStatusOverrides.set(old.stripePaymentIntentId ?? "", "canceled");

    const second = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });

    expect(second.paymentId).not.toBe(first.paymentId);
    expect(stripe.calls.intents[1].key).toBe(`deposit:${booking.id}:1`);
    const [stale] = await t.db.select().from(payment).where(eq(payment.id, first.paymentId));
    expect(stale.status).toBe("failed");
  });

  test("resumes an attempt whose card was declined", async () => {
    const stripe = createFakeStripe();
    const { booking } = await seedBooking(t.db);
    const first = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });
    await t.db.update(payment).set({ status: "failed" }).where(eq(payment.id, first.paymentId));

    const second = await createDepositIntent(t.db, booking.id, { stripe, now: FIXED_NOW });
    expect(second.paymentId).toBe(first.paymentId);
  });

  test("rejects an unknown booking", async () => {
    await expect(
      createDepositIntent(t.db, "00000000-0000-4000-8000-000000000000", {
        stripe: createFakeStripe(),
      }),
    ).rejects.toMatchObject({ code: "booking_not_found" });
  });

  test("rejects a booking that is not pending payment", async () => {
    const { booking } = await seedBooking(t.db, { status: "confirmed" });
    await expect(
      createDepositIntent(t.db, booking.id, { stripe: createFakeStripe(), now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "booking_not_payable" });
  });

  test("rejects when the hold has expired or is missing", async () => {
    const lapsed = await seedBooking(t.db, { holdMinutes: -1 });
    await expect(
      createDepositIntent(t.db, lapsed.booking.id, { stripe: createFakeStripe(), now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "hold_expired" });
  });

  test("rejects a booking with no deposit due", async () => {
    const { booking } = await seedBooking(t.db, { depositCents: 0 });
    await expect(
      createDepositIntent(t.db, booking.id, { stripe: createFakeStripe(), now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "no_deposit_due" });
  });

  test("rejects when the deposit is already paid", async () => {
    const { booking } = await seedBooking(t.db);
    await insertPayment(t.db, {
      bookingId: booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      stripePaymentIntentId: "pi_paid",
    });
    await expect(
      createDepositIntent(t.db, booking.id, { stripe: createFakeStripe(), now: FIXED_NOW }),
    ).rejects.toBeInstanceOf(PaymentError);
  });

  test("fails with a clear message when Stripe is not configured", async () => {
    const { booking } = await seedBooking(t.db);
    const previous = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await expect(createDepositIntent(t.db, booking.id, { now: FIXED_NOW })).rejects.toThrow(
        /STRIPE_SECRET_KEY is not set/,
      );
    } finally {
      if (previous !== undefined) process.env.STRIPE_SECRET_KEY = previous;
    }
  });
});
