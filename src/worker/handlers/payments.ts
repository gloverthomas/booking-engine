import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { payment } from "@/db/schema";
import { expireHolds } from "@/server/booking";
import type { Db } from "@/server/db-types";
import { chargeSavedCard, refundOrphanedDeposits, refundPayment } from "@/server/payments";
import type { LogFn } from "@/lib/logger";
import type { RegisterHandlers } from "../context";

export const PAYMENTS_QUEUE = "consumer.payments";
export const EXPIRE_HOLDS_QUEUE = "bookings.expire_holds";
export const REFUND_ORPHANS_QUEUE = "payments.refund_orphans";

const cancelledEvent = z.object({
  type: z.literal("booking.cancelled"),
  bookingId: z.string(),
  depositAction: z.enum(["refund", "keep", "none"]),
  feeCents: z.number().int().nonnegative().default(0),
});

const noShowEvent = z.object({
  type: z.literal("booking.no_show"),
  bookingId: z.string(),
  feeCents: z.number().int().nonnegative().default(0),
});

export interface PaymentHandlerDeps {
  db: Db;
  log: LogFn;
}

async function refundDeposits(db: Db, bookingId: string): Promise<number> {
  const deposits = await db
    .select({ id: payment.id })
    .from(payment)
    .where(
      and(
        eq(payment.bookingId, bookingId),
        eq(payment.kind, "deposit"),
        inArray(payment.status, ["succeeded", "partially_refunded"]),
      ),
    );
  // refundPayment refunds only what is still unrefunded, so a replay finds nothing left to do.
  for (const { id } of deposits) await refundPayment(db, id);
  return deposits.length;
}

/**
 * React to one domain event. Idempotent: refunds skip anything already refunded and fee charges
 * skip a booking that already has that fee pending, paid or failed-and-recorded.
 */
export async function handlePaymentEvent(
  { db, log }: PaymentHandlerDeps,
  data: Record<string, unknown>,
): Promise<void> {
  if (data.type === "booking.cancelled") {
    const event = cancelledEvent.parse(data);
    if (event.depositAction === "refund") {
      const count = await refundDeposits(db, event.bookingId);
      log({ event: "deposit_refund_processed", bookingId: event.bookingId, deposits: count });
    }
    if (event.feeCents > 0) {
      await chargeSavedCard(db, {
        bookingId: event.bookingId,
        kind: "late_cancel_fee",
        amountCents: event.feeCents,
      });
    }
    return;
  }

  if (data.type === "booking.no_show") {
    const event = noShowEvent.parse(data);
    if (event.feeCents > 0) {
      await chargeSavedCard(db, {
        bookingId: event.bookingId,
        kind: "no_show_fee",
        amountCents: event.feeCents,
      });
    }
  }
}

/** Consumes payment-relevant events and runs the payment housekeeping jobs. */
export const register: RegisterHandlers = async ({ boss, db, log, now }) => {
  await boss.createQueue(PAYMENTS_QUEUE);
  await boss.work<Record<string, unknown>>(PAYMENTS_QUEUE, async (jobs) => {
    for (const job of jobs) await handlePaymentEvent({ db, log }, job.data);
  });

  await boss.createQueue(EXPIRE_HOLDS_QUEUE);
  await boss.work(EXPIRE_HOLDS_QUEUE, async () => {
    const expired = await expireHolds(db, now());
    if (expired > 0) log({ event: "holds_expired", count: expired });
  });
  await boss.schedule(EXPIRE_HOLDS_QUEUE, "* * * * *");

  await boss.createQueue(REFUND_ORPHANS_QUEUE);
  await boss.work(REFUND_ORPHANS_QUEUE, async () => {
    const refunded = await refundOrphanedDeposits(db, { now: now() });
    if (refunded > 0) log({ event: "orphan_deposits_refunded", count: refunded });
  });
  await boss.schedule(REFUND_ORPHANS_QUEUE, "*/5 * * * *");
};
