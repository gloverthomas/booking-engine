import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { payment, webhookEvent } from "@/db/schema";
import { handleStripeWebhook } from "@/server/payments/webhook-handler";
import { FIXED_NOW, createFakeStripe, seedBooking, stripeEvent } from "./helpers";

vi.mock("@/server/booking", () => ({
  confirmBooking: vi.fn(async () => {}),
  expireHolds: vi.fn(async () => 0),
}));

// getEnv() caches its first parse, so the env is mocked to let each test choose its secret.
const env: { STRIPE_WEBHOOK_SECRET?: string } = {};
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});
afterEach(async () => {
  await t.client.close();
});

describe("handleStripeWebhook", () => {
  test("400 when the signature header is missing", async () => {
    const res = await handleStripeWebhook(t.db, { payload: "{}", signature: null });
    expect(res.status).toBe(400);
  });

  test("400 when the signature does not verify, and nothing is stored", async () => {
    const stripe = createFakeStripe();
    stripe.verifyResult = new Error("No signatures found matching the expected signature");
    const res = await handleStripeWebhook(t.db, { payload: "{}", signature: "bad" }, { stripe });
    expect(res).toEqual({ status: 400, body: { received: false, error: "Invalid signature" } });
    expect(await t.db.select().from(webhookEvent)).toHaveLength(0);
  });

  test("passes the raw payload, header and secret to Stripe verification", async () => {
    const stripe = createFakeStripe();
    stripe.verifyResult = stripeEvent("evt_1", "customer.created", {});
    const spy = vi.spyOn(stripe.webhooks, "constructEvent");
    await handleStripeWebhook(
      t.db,
      { payload: '{"raw":true}', signature: "t=1,v1=abc" },
      { stripe },
    );
    expect(spy).toHaveBeenCalledWith('{"raw":true}', "t=1,v1=abc", "whsec_test");
  });

  test("500 with a clear log when the webhook secret is not configured", async () => {
    delete env.STRIPE_WEBHOOK_SECRET;
    const res = await handleStripeWebhook(
      t.db,
      { payload: "{}", signature: "sig" },
      { stripe: createFakeStripe() },
    );
    expect(res.status).toBe(500);
  });

  test("200 for a valid event, 200 with duplicate for a replay", async () => {
    const stripe = createFakeStripe();
    const seeded = await seedBooking(t.db);
    stripe.verifyResult = stripeEvent("evt_1", "payment_intent.succeeded", {
      id: "pi_1",
      amount: 4750,
      latest_charge: "ch_1",
      metadata: { bookingId: seeded.booking.id },
    });

    const first = await handleStripeWebhook(
      t.db,
      { payload: "x", signature: "s" },
      { stripe, now: FIXED_NOW },
    );
    const second = await handleStripeWebhook(
      t.db,
      { payload: "x", signature: "s" },
      { stripe, now: FIXED_NOW },
    );

    expect(first).toEqual({ status: 200, body: { received: true } });
    expect(second).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(await t.db.select().from(payment)).toHaveLength(1);
  });

  test("500 (so Stripe retries) when processing throws", async () => {
    const stripe = createFakeStripe();
    stripe.verifyResult = stripeEvent("evt_1", "payment_intent.succeeded", { nonsense: true });
    const res = await handleStripeWebhook(t.db, { payload: "x", signature: "s" }, { stripe });
    expect(res.status).toBe(500);
    expect(await t.db.select().from(webhookEvent)).toHaveLength(0);
  });
});
