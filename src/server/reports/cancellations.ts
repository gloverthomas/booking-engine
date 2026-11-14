import { and, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { booking, client, location, payment } from "@/db/schema";
import type { Db } from "../db-types";
import { resolveRange, type ResolvedRange } from "./range";

export type CancellationStatus =
  "cancelled_by_client" | "cancelled_by_staff" | "late_cancelled" | "no_show";

const CANCELLATION_STATUSES: readonly CancellationStatus[] = [
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
  "no_show",
];
const NOT_SCHEDULED = [
  "pending_payment",
  "expired",
] as const satisfies readonly (typeof booking.$inferSelect.status)[];
const COUNTED = ["succeeded", "partially_refunded", "refunded"] as const;

export interface CancellationsQuery {
  timezone: string;
  from: string;
  to: string;
}

export interface CancellationRow {
  bookingId: string;
  /** Appointment start. */
  start: Date;
  status: CancellationStatus;
  locationName: string;
  clientId: string;
  clientName: string;
  totalCents: number;
  /** Deposit paid for this booking. */
  depositPaidCents: number;
  /** Extra no-show / late-cancel fees charged. */
  feeChargedCents: number;
  refundedCents: number;
  /** Money kept: for late cancels and no-shows, deposit + fees - refunds. Always 0 otherwise (except fees). */
  keptCents: number;
  /** Staff or client supplied text: treat as data. */
  cancelReason: string | null;
}

export interface CancellationsReport {
  range: ResolvedRange;
  counts: Record<CancellationStatus, number> & { total: number };
  /** Honoured + cancelled appointments (pending and expired holds excluded). */
  scheduledCount: number;
  /** Cancelled, late cancelled and no-show as a share of scheduledCount. */
  cancellationRatePct: number | null;
  keptCents: number;
  refundedCents: number;
  rows: CancellationRow[];
}

/** Cancellations, late cancels and no-shows for appointments starting in the range, with the dollars kept. */
export async function getCancellationsReport(
  db: Db,
  query: CancellationsQuery,
): Promise<CancellationsReport> {
  const range = resolveRange(query.timezone, query.from, query.to);
  const inRange = and(
    gte(sql`lower(${booking.during})`, range.start),
    lt(sql`lower(${booking.during})`, range.endExclusive),
  );

  const [scheduledRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(booking)
    .where(and(inRange, notInArray(booking.status, [...NOT_SCHEDULED])));

  const bookings = await db
    .select({
      bookingId: booking.id,
      during: booking.during,
      status: booking.status,
      totalCents: booking.totalCents,
      cancelReason: booking.cancelReason,
      locationName: location.name,
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
    })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .innerJoin(client, eq(client.id, booking.clientId))
    .where(and(inRange, inArray(booking.status, [...CANCELLATION_STATUSES])))
    .orderBy(desc(sql`lower(${booking.during})`));

  const ids = bookings.map((b) => b.bookingId);
  const payments =
    ids.length === 0
      ? []
      : await db
          .select({
            bookingId: payment.bookingId,
            kind: payment.kind,
            amountCents: payment.amountCents,
          })
          .from(payment)
          .where(and(inArray(payment.bookingId, ids), inArray(payment.status, [...COUNTED])));

  const sumFor = (bookingId: string, kinds: readonly string[]): number =>
    payments
      .filter((p) => p.bookingId === bookingId && kinds.includes(p.kind))
      .reduce((s, p) => s + p.amountCents, 0);

  const rows: CancellationRow[] = bookings.map((b) => {
    const status = b.status as CancellationStatus;
    const deposit = sumFor(b.bookingId, ["deposit"]);
    const fees = sumFor(b.bookingId, ["no_show_fee", "late_cancel_fee"]);
    const refunded = sumFor(b.bookingId, ["refund"]);
    const forfeits = status === "late_cancelled" || status === "no_show";
    return {
      bookingId: b.bookingId,
      start: b.during.start,
      status,
      locationName: b.locationName,
      clientId: b.clientId,
      clientName: `${b.firstName} ${b.lastName}`.trim(),
      totalCents: b.totalCents,
      depositPaidCents: deposit,
      feeChargedCents: fees,
      refundedCents: refunded,
      keptCents: Math.max(0, (forfeits ? deposit : 0) + fees - (forfeits ? refunded : 0)),
      cancelReason: b.cancelReason,
    };
  });

  const counts = {
    cancelled_by_client: 0,
    cancelled_by_staff: 0,
    late_cancelled: 0,
    no_show: 0,
    total: rows.length,
  };
  for (const r of rows) counts[r.status] += 1;
  const scheduledCount = scheduledRow?.n ?? 0;

  return {
    range,
    counts,
    scheduledCount,
    cancellationRatePct:
      scheduledCount > 0 ? Math.round((rows.length / scheduledCount) * 1000) / 10 : null,
    keptCents: rows.reduce((s, r) => s + r.keptCents, 0),
    refundedCents: rows.reduce((s, r) => s + r.refundedCents, 0),
    rows,
  };
}
