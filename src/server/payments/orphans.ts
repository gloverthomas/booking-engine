import { and, eq, sql } from "drizzle-orm";
import { payment } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import type { Db } from "../db-types";
import { refundPayment } from "./refund";
import type { PaymentDeps } from "./stripe";

const log = createLogger("payments");

/**
 * Refund deposits that succeeded after their booking could no longer be confirmed (hold expired,
 * booking cancelled meanwhile). The webhook flags these with metadata.needsRefund. A failure on one
 * payment is logged and does not stop the rest; the payment stays flagged and is retried next run.
 * Returns the number refunded.
 */
export async function refundOrphanedDeposits(db: Db, deps?: PaymentDeps): Promise<number> {
  const orphans = await db
    .select({ id: payment.id })
    .from(payment)
    .where(
      and(
        eq(payment.kind, "deposit"),
        eq(payment.status, "succeeded"),
        sql`${payment.metadata}->>'needsRefund' = 'true'`,
      ),
    );

  let refunded = 0;
  for (const { id } of orphans) {
    try {
      await refundPayment(db, id, undefined, deps);
      refunded += 1;
      log({ event: "orphan_deposit_refunded", paymentId: id });
    } catch (error) {
      log({
        event: "orphan_deposit_refund_failed",
        paymentId: id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return refunded;
}
