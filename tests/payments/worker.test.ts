import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { payment } from "@/db/schema";
import { expireHolds } from "@/server/booking";
import { refundOrphanedDeposits } from "@/server/payments";
import {
  EXPIRE_HOLDS_QUEUE,
  PAYMENTS_QUEUE,
  REFUND_ORPHANS_QUEUE,
  handlePaymentEvent,
  register,
} from "@/worker/handlers/payments";
import type { WorkerContext } from "@/worker/context";
import { createFakeStripe, insertPayment, seedBooking, FIXED_NOW } from "./helpers";

vi.mock("@/server/booking", () => ({
  confirmBooking: vi.fn(async () => {}),
  expireHolds: vi.fn(async () => 3),
}));

// Route the worker's payment calls to the fake Stripe.
const stripe = createFakeStripe();
vi.mock("@/server/payments/stripe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/payments/stripe")>();
  return { ...original, getStripe: () => stripe };
});

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
const log = vi.fn();

beforeEach(async () => {
  stripe.calls.refunds.length = 0;
  stripe.calls.intents.length = 0;
  stripe.nextIntentStatus = "succeeded";
  log.mockClear();
  t = await createTestDb();
});
afterEach(async () => {
  await t.client.close();
});

async function confirmedWithDeposit() {
  const seeded = await seedBooking(t.db, { status: "confirmed", stripeCustomerId: "cus_1" });
  const dep = await insertPayment(t.db, {
    bookingId: seeded.booking.id,
    kind: "deposit",
    method: "stripe_online",
    status: "succeeded",
    amountCents: 4750,
    stripePaymentIntentId: "pi_dep",
    metadata: { paymentMethodId: "pm_1" },
  });
  return { ...seeded, dep };
}

const cancelled = (bookingId: string, depositAction: string, feeCents = 0) => ({
  type: "booking.cancelled",
  bookingId,
  by: "client",
  depositAction,
  feeCents,
});

describe("handlePaymentEvent", () => {
  test("booking.cancelled with refund refunds the deposit once, even when replayed", async () => {
    const { booking, dep } = await confirmedWithDeposit();
    const data = cancelled(booking.id, "refund");

    await handlePaymentEvent({ db: t.db, log }, data);
    await handlePaymentEvent({ db: t.db, log }, data);

    expect(stripe.calls.refunds).toHaveLength(1);
    const refunds = (await t.db.select().from(payment)).filter((p) => p.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].metadata).toMatchObject({ refundOf: dep.id });
  });

  test("booking.cancelled with keep and no fee does nothing", async () => {
    const { booking } = await confirmedWithDeposit();
    await handlePaymentEvent({ db: t.db, log }, cancelled(booking.id, "keep"));
    expect(stripe.calls.refunds).toHaveLength(0);
    expect(stripe.calls.intents).toHaveLength(0);
  });

  test("booking.cancelled with a fee charges the late-cancel fee once, even when replayed", async () => {
    const { booking } = await confirmedWithDeposit();
    const data = cancelled(booking.id, "keep", 1500);

    await handlePaymentEvent({ db: t.db, log }, data);
    await handlePaymentEvent({ db: t.db, log }, data);

    expect(stripe.calls.intents).toHaveLength(1);
    expect(stripe.calls.intents[0].params).toMatchObject({ amount: 1500 });
    const fees = (await t.db.select().from(payment)).filter((p) => p.kind === "late_cancel_fee");
    expect(fees).toHaveLength(1);
  });

  test("booking.cancelled before the deposit was paid has nothing to refund", async () => {
    const seeded = await seedBooking(t.db);
    await handlePaymentEvent({ db: t.db, log }, cancelled(seeded.booking.id, "refund"));
    expect(stripe.calls.refunds).toHaveLength(0);
  });

  test("booking.no_show charges the no-show fee once, even when replayed", async () => {
    const { booking } = await confirmedWithDeposit();
    const data = { type: "booking.no_show", bookingId: booking.id, feeCents: 2000 };

    await handlePaymentEvent({ db: t.db, log }, data);
    await handlePaymentEvent({ db: t.db, log }, data);

    expect(stripe.calls.intents).toHaveLength(1);
    const fees = (await t.db.select().from(payment)).filter((p) => p.kind === "no_show_fee");
    expect(fees).toHaveLength(1);
  });

  test("booking.no_show without a fee does nothing", async () => {
    const { booking } = await confirmedWithDeposit();
    await handlePaymentEvent(
      { db: t.db, log },
      { type: "booking.no_show", bookingId: booking.id, feeCents: 0 },
    );
    expect(stripe.calls.intents).toHaveLength(0);
  });

  test("ignores event types it does not handle", async () => {
    await handlePaymentEvent({ db: t.db, log }, { type: "booking.confirmed", bookingId: "x" });
    expect(stripe.calls.refunds).toHaveLength(0);
  });
});

describe("refundOrphanedDeposits", () => {
  test("refunds deposits flagged needsRefund and leaves other payments alone", async () => {
    const seeded = await seedBooking(t.db, { status: "expired" });
    const orphan = await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      stripePaymentIntentId: "pi_orphan",
      metadata: { needsRefund: true, needsRefundReason: "booking_expired" },
    });
    const normal = await seedBooking(t.db, { status: "confirmed" });
    await insertPayment(t.db, {
      bookingId: normal.booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      stripePaymentIntentId: "pi_normal",
    });

    expect(await refundOrphanedDeposits(t.db, { now: FIXED_NOW })).toBe(1);
    expect(await refundOrphanedDeposits(t.db, { now: FIXED_NOW })).toBe(0);

    expect(stripe.calls.refunds).toHaveLength(1);
    expect(stripe.calls.refunds[0].params.payment_intent).toBe("pi_orphan");
    const [row] = (await t.db.select().from(payment)).filter((p) => p.id === orphan.id);
    expect(row.status).toBe("refunded");
  });

  test("a failure on one payment is skipped and retried on the next run", async () => {
    const seeded = await seedBooking(t.db, { status: "expired" });
    await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 4750,
      stripePaymentIntentId: "pi_orphan",
      metadata: { needsRefund: true },
    });
    stripe.failNextRefund = new Error("Stripe is down");
    expect(await refundOrphanedDeposits(t.db)).toBe(0);
    expect(await refundOrphanedDeposits(t.db)).toBe(1);
  });
});

describe("register", () => {
  function fakeBoss() {
    const handlers = new Map<
      string,
      (jobs: Array<{ data: Record<string, unknown> }>) => Promise<void>
    >();
    return {
      handlers,
      boss: {
        createQueue: vi.fn(async () => {}),
        work: vi.fn(async (name: string, handler: never) => {
          handlers.set(name, handler);
          return "id";
        }),
        schedule: vi.fn(async () => {}),
      },
    };
  }

  test("registers the consumer and the two scheduled jobs", async () => {
    const { boss, handlers } = fakeBoss();
    const ctx = { boss, db: t.db, log, now: () => FIXED_NOW } as unknown as WorkerContext;
    await register(ctx);

    expect([...handlers.keys()].sort()).toEqual(
      [EXPIRE_HOLDS_QUEUE, PAYMENTS_QUEUE, REFUND_ORPHANS_QUEUE].sort(),
    );
    expect(boss.schedule).toHaveBeenCalledWith(EXPIRE_HOLDS_QUEUE, "* * * * *");
    expect(boss.schedule).toHaveBeenCalledWith(REFUND_ORPHANS_QUEUE, "*/5 * * * *");
  });

  test("the queue handlers do their work", async () => {
    const { boss, handlers } = fakeBoss();
    const ctx = { boss, db: t.db, log, now: () => FIXED_NOW } as unknown as WorkerContext;
    await register(ctx);

    const { booking } = await confirmedWithDeposit();
    await handlers.get(PAYMENTS_QUEUE)?.([{ data: cancelled(booking.id, "refund") }]);
    expect(stripe.calls.refunds).toHaveLength(1);

    await handlers.get(EXPIRE_HOLDS_QUEUE)?.([]);
    expect(expireHolds).toHaveBeenCalledWith(t.db, FIXED_NOW);
    expect(log).toHaveBeenCalledWith({ event: "holds_expired", count: 3 });

    const seeded = await seedBooking(t.db, { status: "expired" });
    await insertPayment(t.db, {
      bookingId: seeded.booking.id,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 100,
      stripePaymentIntentId: "pi_o",
      metadata: { needsRefund: true },
    });
    await handlers.get(REFUND_ORPHANS_QUEUE)?.([]);
    expect(log).toHaveBeenCalledWith({ event: "orphan_deposits_refunded", count: 1 });
  });
});
