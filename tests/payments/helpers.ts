import { eq } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import type { Db } from "@/server/db-types";
import type {
  StripeEventLike,
  StripeIntentLike,
  StripeLike,
  StripeRefundLike,
} from "@/server/payments/stripe";
import { seedBasics } from "../helpers/factories";

type IntentParams = Parameters<StripeLike["paymentIntents"]["create"]>[0];

export interface FakeStripe extends StripeLike {
  calls: {
    customers: Array<{ params: unknown; key: string }>;
    intents: Array<{ params: IntentParams; key: string }>;
    refunds: Array<{ params: { payment_intent: string; amount: number }; key: string }>;
    retrieved: string[];
    cancelled: string[];
    connectionTokens: Array<{ location?: string }>;
  };
  /** Next paymentIntents.create rejects with this error (then clears). */
  failNextIntent: unknown;
  /** Status the next created intent reports. */
  nextIntentStatus: string;
  /** Status of the next refund. */
  nextRefundStatus: string | null;
  /** Next refunds.create rejects with this error (then clears). */
  failNextRefund: unknown;
  /** Override the status reported by retrieve for an intent id. */
  intentStatusOverrides: Map<string, string>;
  /** What constructEvent returns, or throws when it is an Error. */
  verifyResult: StripeEventLike | Error;
}

/** In-memory Stripe: honours idempotency keys the way the real API does. */
export function createFakeStripe(): FakeStripe {
  const customersByKey = new Map<string, { id: string }>();
  const intentsByKey = new Map<string, StripeIntentLike>();
  const intents = new Map<string, StripeIntentLike>();
  const refundsByKey = new Map<string, StripeRefundLike>();
  let sequence = 0;

  const fake: FakeStripe = {
    calls: {
      customers: [],
      intents: [],
      refunds: [],
      retrieved: [],
      cancelled: [],
      connectionTokens: [],
    },
    failNextIntent: null,
    nextIntentStatus: "requires_payment_method",
    nextRefundStatus: "succeeded",
    failNextRefund: null,
    intentStatusOverrides: new Map(),
    verifyResult: new Error("not configured"),
    customers: {
      async create(params, options) {
        fake.calls.customers.push({ params, key: options.idempotencyKey });
        const existing = customersByKey.get(options.idempotencyKey);
        if (existing) return existing;
        const created = { id: `cus_${++sequence}` };
        customersByKey.set(options.idempotencyKey, created);
        return created;
      },
    },
    paymentIntents: {
      async create(params, options) {
        fake.calls.intents.push({ params, key: options.idempotencyKey });
        if (fake.failNextIntent) {
          const error = fake.failNextIntent;
          fake.failNextIntent = null;
          throw error;
        }
        const existing = intentsByKey.get(options.idempotencyKey);
        if (existing) return existing;
        const id = `pi_${++sequence}`;
        const created: StripeIntentLike = {
          id,
          status: fake.nextIntentStatus,
          amount: params.amount,
          client_secret: `${id}_secret`,
        };
        intentsByKey.set(options.idempotencyKey, created);
        intents.set(id, created);
        return created;
      },
      async cancel(id) {
        fake.calls.cancelled.push(id);
        const found = intents.get(id);
        if (!found) throw new Error(`No such intent ${id}`);
        const cancelled = { ...found, status: "canceled" };
        intents.set(id, cancelled);
        return cancelled;
      },
      async retrieve(id) {
        fake.calls.retrieved.push(id);
        const found = intents.get(id);
        if (!found) throw new Error(`No such intent ${id}`);
        const status = fake.intentStatusOverrides.get(id);
        return status ? { ...found, status } : found;
      },
    },
    refunds: {
      async create(params, options) {
        fake.calls.refunds.push({ params, key: options.idempotencyKey });
        if (fake.failNextRefund) {
          const error = fake.failNextRefund;
          fake.failNextRefund = null;
          throw error;
        }
        const existing = refundsByKey.get(options.idempotencyKey);
        if (existing) return existing;
        const created = { id: `re_${++sequence}`, status: fake.nextRefundStatus };
        refundsByKey.set(options.idempotencyKey, created);
        return created;
      },
    },
    terminal: {
      connectionTokens: {
        async create(params) {
          fake.calls.connectionTokens.push(params);
          return { secret: `pst_test_${++sequence}` };
        },
      },
    },
    webhooks: {
      constructEvent() {
        if (fake.verifyResult instanceof Error) throw fake.verifyResult;
        return fake.verifyResult;
      },
    },
  };
  return fake;
}

export const FIXED_NOW = new Date("2026-11-20T01:00:00Z");

interface BookingOptions {
  status?: (typeof booking.$inferInsert)["status"];
  totalCents?: number;
  depositCents?: number;
  /** Minutes from FIXED_NOW. Negative = already lapsed. Null = no hold. */
  holdMinutes?: number | null;
  stripeCustomerId?: string | null;
}

export async function seedBooking(db: Db, options: BookingOptions = {}) {
  const seed = await seedBasics(db);
  if (options.stripeCustomerId) {
    await db
      .update(client)
      .set({ stripeCustomerId: options.stripeCustomerId })
      .where(eq(client.id, seed.cl.id));
  }
  const holdMinutes = options.holdMinutes === undefined ? 10 : options.holdMinutes;
  const [b] = await db
    .insert(booking)
    .values({
      staffId: seed.stylist.id,
      locationId: seed.loc.id,
      clientId: seed.cl.id,
      status: options.status ?? "pending_payment",
      during: {
        start: new Date("2026-11-25T03:00:00Z"),
        end: new Date("2026-11-25T03:45:00Z"),
      },
      totalCents: options.totalCents ?? 9500,
      depositCents: options.depositCents ?? 4750,
      holdExpiresAt:
        holdMinutes === null ? null : new Date(FIXED_NOW.getTime() + holdMinutes * 60_000),
    })
    .returning();
  return { ...seed, booking: b };
}

export async function insertPayment(db: Db, values: typeof payment.$inferInsert) {
  const [row] = await db.insert(payment).values(values).returning();
  return row;
}

export function stripeEvent(
  id: string,
  type: string,
  object: Record<string, unknown>,
  created?: number,
): StripeEventLike {
  return { id, type, data: { object }, ...(created ? { created } : {}) };
}
