import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { booking, domainEvent, payment } from "@/db/schema";
import {
  PaymentError,
  createConnectionToken,
  inPersonPaymentStatus,
  processStripeEvent,
  startInPersonPayment,
  terminalLocationId,
} from "@/server/payments";
import { createTestDb } from "../helpers/test-db";
import {
  FIXED_NOW,
  createFakeStripe,
  insertPayment,
  seedBooking,
  stripeEvent,
  type FakeStripe,
} from "./helpers";

const env = vi.hoisted(() => ({ STRIPE_TERMINAL_LOCATION_ID: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let stripe: FakeStripe;
const deps = () => ({ stripe, now: FIXED_NOW });

beforeEach(async () => {
  t = await createTestDb();
  stripe = createFakeStripe();
  env.STRIPE_TERMINAL_LOCATION_ID = undefined;
});
afterEach(async () => {
  await t.client.close();
});

/** A confirmed $95 booking with the $47.50 deposit already paid online. */
async function confirmedBooking(options: Parameters<typeof seedBooking>[1] = {}) {
  const seeded = await seedBooking(t.db, { status: "confirmed", holdMinutes: null, ...options });
  await insertPayment(t.db, {
    bookingId: seeded.booking.id,
    kind: "deposit",
    method: "stripe_online",
    status: "succeeded",
    amountCents: 4750,
    stripePaymentIntentId: "pi_deposit",
  });
  return seeded;
}
const payments = (bookingId: string) =>
  t.db.select().from(payment).where(eq(payment.bookingId, bookingId));
const inPerson = async (bookingId: string) =>
  (await payments(bookingId)).filter((p) => p.method === "stripe_in_person");

describe("connection token and location", () => {
  test("a token is created, scoped to the salon location when one is set", async () => {
    expect(terminalLocationId()).toBeNull();
    expect((await createConnectionToken(deps())).secret).toMatch(/^pst_test_/);
    expect(stripe.calls.connectionTokens.at(-1)).toEqual({});

    env.STRIPE_TERMINAL_LOCATION_ID = "tml_123";
    expect(terminalLocationId()).toBe("tml_123");
    await createConnectionToken(deps());
    expect(stripe.calls.connectionTokens.at(-1)).toEqual({ location: "tml_123" });
  });
});

describe("startInPersonPayment", () => {
  test("opens a card-present intent for exactly what is owing and records it as pending", async () => {
    const { booking: b } = await confirmedBooking();
    const result = await startInPersonPayment(t.db, b.id, deps());

    expect(result.amountCents).toBe(4750);
    expect(result.clientSecret).toBe(`${result.paymentIntentId}_secret`);
    const [call] = stripe.calls.intents;
    expect(call.params).toMatchObject({
      amount: 4750,
      currency: "aud",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: { bookingId: b.id, kind: "balance", channel: "tap_to_pay" },
    });
    expect(call.params).not.toHaveProperty("customer");

    const [row] = await inPerson(b.id);
    expect(row).toMatchObject({
      id: result.paymentId,
      kind: "balance",
      method: "stripe_in_person",
      status: "pending",
      amountCents: 4750,
      stripePaymentIntentId: result.paymentIntentId,
    });
  });

  test("the receipt goes to the client's email", async () => {
    const { booking: b } = await confirmedBooking();
    await startInPersonPayment(t.db, b.id, deps());
    expect(stripe.calls.intents[0].params.receipt_email).toBe("sam@example.com");
  });

  test("a second tap on the button resumes the same payment instead of opening another", async () => {
    const { booking: b } = await confirmedBooking();
    const first = await startInPersonPayment(t.db, b.id, deps());
    const second = await startInPersonPayment(t.db, b.id, deps());
    expect(second).toEqual(first);
    expect(stripe.calls.intents).toHaveLength(1);
    expect(await inPerson(b.id)).toHaveLength(1);
  });

  test("after a declined card the same payment is offered again, back to pending", async () => {
    const { booking: b } = await confirmedBooking();
    const first = await startInPersonPayment(t.db, b.id, deps());
    await t.db.update(payment).set({ status: "failed" }).where(eq(payment.id, first.paymentId));

    const again = await startInPersonPayment(t.db, b.id, deps());
    expect(again.paymentId).toBe(first.paymentId);
    expect((await inPerson(b.id))[0].status).toBe("pending");
  });

  test("if the amount owing changed, the old intent is cancelled and a new one opened", async () => {
    const { booking: b } = await confirmedBooking();
    const first = await startInPersonPayment(t.db, b.id, deps());
    await t.db.update(booking).set({ totalCents: 8000 }).where(eq(booking.id, b.id));

    const second = await startInPersonPayment(t.db, b.id, deps());
    expect(second.amountCents).toBe(3250);
    expect(second.paymentIntentId).not.toBe(first.paymentIntentId);
    expect(stripe.calls.cancelled).toEqual([first.paymentIntentId]);
    const rows = await inPerson(b.id);
    expect(rows.find((r) => r.id === first.paymentId)).toMatchObject({ status: "failed" });
    expect(rows.find((r) => r.id === second.paymentId)).toMatchObject({
      status: "pending",
      amountCents: 3250,
    });
  });

  test("a payment that already went through is never charged twice", async () => {
    const { booking: b } = await confirmedBooking();
    const first = await startInPersonPayment(t.db, b.id, deps());
    stripe.intentStatusOverrides.set(first.paymentIntentId, "succeeded");

    await expect(startInPersonPayment(t.db, b.id, deps())).rejects.toMatchObject({
      code: "booking_not_payable",
    });
    expect(stripe.calls.intents).toHaveLength(1);
  });

  test.each([
    ["pending_payment", "booking_not_payable"],
    ["cancelled_by_staff", "booking_not_payable"],
    ["completed", "booking_not_payable"],
    ["no_show", "booking_not_payable"],
  ] as const)("a %s booking cannot be paid for", async (status, code) => {
    const { booking: b } = await confirmedBooking({ status });
    await expect(startInPersonPayment(t.db, b.id, deps())).rejects.toMatchObject({ code });
    expect(stripe.calls.intents).toHaveLength(0);
  });

  test("nothing owing, and an unknown booking, are refused", async () => {
    const { booking: b } = await confirmedBooking({ totalCents: 4750 });
    await expect(startInPersonPayment(t.db, b.id, deps())).rejects.toMatchObject({
      code: "nothing_owing",
    });
    await expect(
      startInPersonPayment(t.db, "00000000-0000-4000-8000-000000000000", deps()),
    ).rejects.toMatchObject({ code: "booking_not_found" });
  });

  test("a refunded deposit raises what is owing", async () => {
    const { booking: b } = await confirmedBooking();
    const [deposit] = await payments(b.id);
    await insertPayment(t.db, {
      bookingId: b.id,
      kind: "refund",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      metadata: { refundOf: deposit.id },
    });
    expect((await startInPersonPayment(t.db, b.id, deps())).amountCents).toBe(9500);
  });

  test("without Stripe configured it fails with a typed error, not a crash", async () => {
    const { booking: b } = await confirmedBooking();
    await expect(startInPersonPayment(t.db, b.id)).rejects.toBeInstanceOf(PaymentError);
  });
});

describe("when Stripe confirms the tap", () => {
  const succeededEvent = (intentId: string, amount: number, id = "evt_1") =>
    stripeEvent(id, "payment_intent.succeeded", {
      id: intentId,
      amount,
      latest_charge: "ch_tap",
      payment_method: "pm_tap",
      metadata: {},
    });
  const eventTypes = async () => (await t.db.select().from(domainEvent)).map((e) => e.type);

  test("the payment is recorded and the appointment is completed", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());

    expect(
      await processStripeEvent(t.db, succeededEvent(started.paymentIntentId, 4750), deps()),
    ).toBe("processed");

    const [row] = await inPerson(b.id);
    expect(row).toMatchObject({
      status: "succeeded",
      stripeChargeId: "ch_tap",
      method: "stripe_in_person",
      kind: "balance",
    });
    const [after] = await t.db.select().from(booking).where(eq(booking.id, b.id));
    expect(after.status).toBe("completed");
    expect(await eventTypes()).toEqual(
      expect.arrayContaining(["payment.succeeded", "booking.completed"]),
    );
  });

  test("it is not mistaken for an online deposit, so nothing is refunded as a duplicate", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());
    await processStripeEvent(t.db, succeededEvent(started.paymentIntentId, 4750), deps());
    const all = await payments(b.id);
    expect(all.filter((p) => p.kind === "deposit")).toHaveLength(1);
    expect(all.some((p) => p.metadata.needsRefund)).toBe(false);
    expect(all.some((p) => p.kind === "refund")).toBe(false);
  });

  test("a replayed event does nothing the second time", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());
    const event = succeededEvent(started.paymentIntentId, 4750);
    await processStripeEvent(t.db, event, deps());
    expect(await processStripeEvent(t.db, event, deps())).toBe("duplicate");
    expect((await eventTypes()).filter((e) => e === "booking.completed")).toHaveLength(1);
  });

  test("a card that fails first and succeeds on the retry still ends up paid and completed", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());
    await processStripeEvent(
      t.db,
      stripeEvent("evt_fail", "payment_intent.payment_failed", {
        id: started.paymentIntentId,
        amount: 4750,
        metadata: {},
        last_payment_error: { message: "Your card was declined." },
      }),
      deps(),
    );
    expect((await inPerson(b.id))[0].status).toBe("failed");

    await processStripeEvent(t.db, succeededEvent(started.paymentIntentId, 4750, "evt_ok"), deps());
    expect((await inPerson(b.id))[0].status).toBe("succeeded");
    expect((await t.db.select().from(booking).where(eq(booking.id, b.id)))[0].status).toBe(
      "completed",
    );
  });

  test("if the booking was cancelled meanwhile, the money is still recorded and the booking is left alone", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());
    await t.db.update(booking).set({ status: "cancelled_by_staff" }).where(eq(booking.id, b.id));

    await processStripeEvent(t.db, succeededEvent(started.paymentIntentId, 4750), deps());
    expect((await inPerson(b.id))[0].status).toBe("succeeded");
    expect((await t.db.select().from(booking).where(eq(booking.id, b.id)))[0].status).toBe(
      "cancelled_by_staff",
    );
  });

  test("a part-payment does not complete the booking", async () => {
    const { booking: b } = await confirmedBooking();
    const row = await insertPayment(t.db, {
      bookingId: b.id,
      kind: "balance",
      method: "stripe_in_person",
      status: "pending",
      amountCents: 2000,
      stripePaymentIntentId: "pi_part",
    });
    await processStripeEvent(t.db, succeededEvent("pi_part", 2000), deps());
    expect((await t.db.select().from(payment).where(eq(payment.id, row.id)))[0].status).toBe(
      "succeeded",
    );
    expect((await t.db.select().from(booking).where(eq(booking.id, b.id)))[0].status).toBe(
      "confirmed",
    );
  });
});

describe("inPersonPaymentStatus", () => {
  test("reports the payment, the booking and what is still owing", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());
    expect(await inPersonPaymentStatus(t.db, b.id, started.paymentId)).toEqual({
      status: "pending",
      bookingStatus: "confirmed",
      balanceDueCents: 4750,
    });
    await processStripeEvent(
      t.db,
      stripeEvent("e", "payment_intent.succeeded", {
        id: started.paymentIntentId,
        amount: 4750,
        metadata: {},
      }),
      deps(),
    );
    expect(await inPersonPaymentStatus(t.db, b.id, started.paymentId)).toEqual({
      status: "succeeded",
      bookingStatus: "completed",
      balanceDueCents: 0,
    });
  });

  test("another booking's payment id is not found", async () => {
    const { booking: b } = await confirmedBooking();
    const started = await startInPersonPayment(t.db, b.id, deps());
    await expect(
      inPersonPaymentStatus(t.db, "00000000-0000-4000-8000-000000000000", started.paymentId),
    ).rejects.toMatchObject({ code: "payment_not_found" });
  });
});
