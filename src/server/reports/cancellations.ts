import { and, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { booking, client, location, payment, staff } from "@/db/schema";
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
  /** Only this stylist's appointments. Role scoping sets this on the server. */
  staffId?: string;
  /** "staff" also fills `byStaff`. */
  groupBy?: "none" | "staff";
}

export interface StaffCancellationRow {
  staffId: string;
  staffName: string;
  scheduledCount: number;
  cancelled: number;
  lateCancelled: number;
  noShows: number;
  /** All four outcomes as a share of this stylist's scheduled appointments. */
  cancellationRatePct: number | null;
  keptCents: number;
  refundedCents: number;
}

export interface CancellationRow {
  bookingId: string;
  staffId: string;
  staffName: string;
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
  /** Per stylist. Empty unless the query asked for groupBy "staff". */
  byStaff: StaffCancellationRow[];
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
    query.staffId ? eq(booking.staffId, query.staffId) : undefined,
  );

  const scheduledRows = await db
    .select({ staffId: booking.staffId, n: sql<number>`count(*)::int` })
    .from(booking)
    .where(and(inRange, notInArray(booking.status, [...NOT_SCHEDULED])))
    .groupBy(booking.staffId);
  const scheduledByStaff = new Map(scheduledRows.map((r) => [r.staffId, r.n]));

  const bookings = await db
    .select({
      bookingId: booking.id,
      staffId: booking.staffId,
      staffName: staff.name,
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
    .innerJoin(staff, eq(staff.id, booking.staffId))
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
      staffId: b.staffId,
      staffName: b.staffName,
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
  const scheduledCount = [...scheduledByStaff.values()].reduce((s, n) => s + n, 0);

  const byStaff: StaffCancellationRow[] =
    query.groupBy === "staff"
      ? [...new Set([...scheduledByStaff.keys(), ...rows.map((r) => r.staffId)])]
          .map((id) => {
            const own = rows.filter((r) => r.staffId === id);
            const scheduled = scheduledByStaff.get(id) ?? 0;
            return {
              staffId: id,
              staffName: own[0]?.staffName ?? "",
              scheduledCount: scheduled,
              cancelled: own.filter(
                (r) => r.status === "cancelled_by_client" || r.status === "cancelled_by_staff",
              ).length,
              lateCancelled: own.filter((r) => r.status === "late_cancelled").length,
              noShows: own.filter((r) => r.status === "no_show").length,
              cancellationRatePct:
                scheduled > 0 ? Math.round((own.length / scheduled) * 1000) / 10 : null,
              keptCents: own.reduce((s, r) => s + r.keptCents, 0),
              refundedCents: own.reduce((s, r) => s + r.refundedCents, 0),
            };
          })
          .sort((a, b) => a.staffName.localeCompare(b.staffName))
      : [];

  return {
    byStaff,
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
