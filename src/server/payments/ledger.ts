import { and, eq, sql } from "drizzle-orm";
import { payment } from "@/db/schema";
import type { Db } from "../db-types";

export type PaymentRow = typeof payment.$inferSelect;

const SETTLED = new Set<PaymentRow["status"]>(["succeeded", "partially_refunded", "refunded"]);

/** Refund rows point at the payment they reduce via metadata.refundOf. */
export async function listRefundsOf(db: Db, paymentId: string): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payment)
    .where(
      and(
        eq(payment.kind, "refund"),
        eq(payment.status, "succeeded"),
        sql`${payment.metadata}->>'refundOf' = ${paymentId}`,
      ),
    );
}

export function sumCents(rows: ReadonlyArray<{ amountCents: number }>): number {
  return rows.reduce((total, row) => total + row.amountCents, 0);
}

/** Lock a payment row for the rest of the transaction so refunds and webhooks serialise. */
export async function lockPayment(db: Db, paymentId: string): Promise<PaymentRow | undefined> {
  const [row] = await db.select().from(payment).where(eq(payment.id, paymentId)).for("update");
  return row;
}

export async function listBookingPayments(db: Db, bookingId: string): Promise<PaymentRow[]> {
  return db.select().from(payment).where(eq(payment.bookingId, bookingId));
}

/**
 * Money received against the booking total (deposit + balance), net of refunds.
 * Fees (no-show / late cancel) are separate charges and never count toward the balance.
 */
export function netPaidCents(rows: readonly PaymentRow[]): number {
  const serviceRows = rows.filter(
    (row) => (row.kind === "deposit" || row.kind === "balance") && SETTLED.has(row.status),
  );
  const serviceIds = new Set(serviceRows.map((row) => row.id));
  const gross = sumCents(serviceRows);
  const refunded = rows
    .filter((row) => row.kind === "refund" && row.status === "succeeded")
    .filter((row) => serviceIds.has(String(row.metadata.refundOf ?? "")))
    .reduce((total, row) => total + row.amountCents, 0);
  return gross - refunded;
}
