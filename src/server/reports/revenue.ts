import { and, gte, inArray, lt, eq } from "drizzle-orm";
import { booking, bookingService, location, payment, staff } from "@/db/schema";
import type { Db } from "../db-types";
import { allocateProRata } from "./money";
import {
  bucketStart,
  listBuckets,
  resolveRange,
  type Granularity,
  type ResolvedRange,
} from "./range";

export type RevenueGroupBy = "none" | "location" | "service" | "staff";

export interface RevenueQuery {
  timezone: string;
  /** Inclusive local dates (YYYY-MM-DD). */
  from: string;
  to: string;
  granularity: Granularity;
  groupBy: RevenueGroupBy;
  /**
   * Only payments on this stylist's bookings (payments not tied to a booking are left out). Role scoping
   * sets this on the server for people who may only see their own numbers.
   */
  staffId?: string;
}

/** Money columns shared by every revenue row. All integer cents (AUD). */
export interface RevenueFigures {
  depositsCents: number;
  balancesCents: number;
  /** Extra fees charged to the saved card after a late cancel or no-show. */
  feeChargesCents: number;
  /** deposits + balances + fee charges. */
  grossCents: number;
  refundsCents: number;
  /** gross - refunds. */
  netCents: number;
  /** Deposits on late-cancelled / no-show bookings that were not returned. */
  forfeitedDepositsCents: number;
  /** Forfeited deposits + fee charges: money kept because the client did not turn up or cancelled late. */
  feesKeptCents: number;
  paymentCount: number;
}

export interface RevenueRow extends RevenueFigures {
  /** Local date of the start of the bucket. */
  period: string;
  groupId: string | null;
  groupName: string | null;
}

export interface RevenueReport {
  range: ResolvedRange;
  granularity: Granularity;
  groupBy: RevenueGroupBy;
  rows: RevenueRow[];
  /** One entry per bucket (zero filled), ignoring groupBy. Drives the chart. */
  series: Array<RevenueFigures & { period: string }>;
  totals: RevenueFigures;
}

/** Payments in these states represent money that moved. Pending and failed ones are ignored. */
const COUNTED_STATUSES = ["succeeded", "partially_refunded", "refunded"] as const;
const FEE_KINDS = new Set(["no_show_fee", "late_cancel_fee"]);
const FORFEIT_STATUSES = new Set(["late_cancelled", "no_show"]);
const CHUNK = 500;

export const EMPTY_FIGURES: RevenueFigures = {
  depositsCents: 0,
  balancesCents: 0,
  feeChargesCents: 0,
  grossCents: 0,
  refundsCents: 0,
  netCents: 0,
  forfeitedDepositsCents: 0,
  feesKeptCents: 0,
  paymentCount: 0,
};

interface Contribution {
  kind: string;
  amountCents: number;
  forfeited: boolean;
}

/** Return new figures with one payment folded in (immutable). */
export function addToFigures(f: RevenueFigures, c: Contribution): RevenueFigures {
  const isRefund = c.kind === "refund";
  const deposits = f.depositsCents + (c.kind === "deposit" ? c.amountCents : 0);
  const balances = f.balancesCents + (c.kind === "balance" ? c.amountCents : 0);
  const fees = f.feeChargesCents + (FEE_KINDS.has(c.kind) ? c.amountCents : 0);
  const refunds = f.refundsCents + (isRefund ? c.amountCents : 0);
  const forfeited = f.forfeitedDepositsCents + (c.forfeited ? c.amountCents : 0);
  const gross = deposits + balances + fees;
  return {
    depositsCents: deposits,
    balancesCents: balances,
    feeChargesCents: fees,
    grossCents: gross,
    refundsCents: refunds,
    netCents: gross - refunds,
    forfeitedDepositsCents: forfeited,
    feesKeptCents: forfeited + fees,
    paymentCount: f.paymentCount + 1,
  };
}

export function sumFigures(list: readonly RevenueFigures[]): RevenueFigures {
  return list.reduce<RevenueFigures>(
    (acc, f) => ({
      depositsCents: acc.depositsCents + f.depositsCents,
      balancesCents: acc.balancesCents + f.balancesCents,
      feeChargesCents: acc.feeChargesCents + f.feeChargesCents,
      grossCents: acc.grossCents + f.grossCents,
      refundsCents: acc.refundsCents + f.refundsCents,
      netCents: acc.netCents + f.netCents,
      forfeitedDepositsCents: acc.forfeitedDepositsCents + f.forfeitedDepositsCents,
      feesKeptCents: acc.feesKeptCents + f.feesKeptCents,
      paymentCount: acc.paymentCount + f.paymentCount,
    }),
    EMPTY_FIGURES,
  );
}

interface PaymentRow {
  id: string;
  kind: string;
  status: string;
  amountCents: number;
  createdAt: Date;
  bookingId: string | null;
  bookingStatus: string | null;
  locationId: string | null;
  locationName: string | null;
  staffId: string | null;
  staffName: string | null;
}

async function loadPayments(db: Db, range: ResolvedRange, staffId?: string): Promise<PaymentRow[]> {
  return db
    .select({
      id: payment.id,
      kind: payment.kind,
      status: payment.status,
      amountCents: payment.amountCents,
      createdAt: payment.createdAt,
      bookingId: payment.bookingId,
      bookingStatus: booking.status,
      locationId: booking.locationId,
      locationName: location.name,
      staffId: booking.staffId,
      staffName: staff.name,
    })
    .from(payment)
    .leftJoin(booking, eq(booking.id, payment.bookingId))
    .leftJoin(location, eq(location.id, booking.locationId))
    .leftJoin(staff, eq(staff.id, booking.staffId))
    .where(
      and(
        staffId ? eq(booking.staffId, staffId) : undefined,
        gte(payment.createdAt, range.start),
        lt(payment.createdAt, range.endExclusive),
        inArray(payment.status, [...COUNTED_STATUSES]),
      ),
    );
}

interface ServiceLine {
  serviceId: string | null;
  name: string;
  priceCents: number;
}

async function loadServiceLines(
  db: Db,
  bookingIds: readonly string[],
): Promise<Map<string, ServiceLine[]>> {
  const byBooking = new Map<string, ServiceLine[]>();
  for (let i = 0; i < bookingIds.length; i += CHUNK) {
    const rows = await db
      .select({
        bookingId: bookingService.bookingId,
        serviceId: bookingService.serviceId,
        name: bookingService.name,
        priceCents: bookingService.priceCents,
      })
      .from(bookingService)
      .where(inArray(bookingService.bookingId, bookingIds.slice(i, i + CHUNK)))
      .orderBy(bookingService.position);
    for (const r of rows) {
      byBooking.set(r.bookingId, [
        ...(byBooking.get(r.bookingId) ?? []),
        { serviceId: r.serviceId, name: r.name, priceCents: r.priceCents },
      ]);
    }
  }
  return byBooking;
}

interface Slice {
  groupId: string | null;
  groupName: string | null;
  amountCents: number;
}

/** Split one payment into the group(s) it belongs to. Service grouping allocates pro rata by line price. */
function slicesFor(
  row: PaymentRow,
  groupBy: RevenueGroupBy,
  lines: Map<string, ServiceLine[]>,
): Slice[] {
  if (groupBy === "none") return [{ groupId: null, groupName: null, amountCents: row.amountCents }];
  if (groupBy === "location") {
    return [
      {
        groupId: row.locationId,
        groupName: row.locationName ?? "No location",
        amountCents: row.amountCents,
      },
    ];
  }
  if (groupBy === "staff") {
    return [
      {
        groupId: row.staffId,
        groupName: row.staffName ?? "Not assigned",
        amountCents: row.amountCents,
      },
    ];
  }
  const serviceLines = row.bookingId ? lines.get(row.bookingId) : undefined;
  if (!serviceLines || serviceLines.length === 0) {
    return [{ groupId: null, groupName: "No service", amountCents: row.amountCents }];
  }
  const parts = allocateProRata(
    row.amountCents,
    serviceLines.map((l) => l.priceCents),
  );
  return serviceLines.map((l, i) => ({
    groupId: l.serviceId,
    groupName: l.name,
    amountCents: parts[i],
  }));
}

/**
 * Revenue on a cash basis: each payment lands on the local day it was recorded (business timezone).
 * Pending and failed payments are ignored. Refunds are their own column, never netted into gross.
 * With groupBy "service", a payment on a multi-service booking is split pro rata by line price.
 */
export async function getRevenueReport(db: Db, query: RevenueQuery): Promise<RevenueReport> {
  const range = resolveRange(query.timezone, query.from, query.to);
  const payments = await loadPayments(db, range, query.staffId);
  const bookingIds = [...new Set(payments.flatMap((p) => (p.bookingId ? [p.bookingId] : [])))];
  const lines =
    query.groupBy === "service"
      ? await loadServiceLines(db, bookingIds)
      : new Map<string, ServiceLine[]>();

  const byRow = new Map<string, RevenueRow>();
  const byPeriod = new Map<string, RevenueFigures>();

  for (const p of payments) {
    const period = bucketStart(p.createdAt, query.granularity, query.timezone);
    const forfeitable =
      p.kind === "deposit" &&
      p.status !== "refunded" &&
      FORFEIT_STATUSES.has(p.bookingStatus ?? "");
    for (const slice of slicesFor(p, query.groupBy, lines)) {
      const contribution = {
        kind: p.kind,
        amountCents: slice.amountCents,
        forfeited: forfeitable,
      };
      const key = `${period}|${slice.groupId ?? ""}|${slice.groupName ?? ""}`;
      const existing = byRow.get(key);
      const figures = addToFigures(existing ?? EMPTY_FIGURES, contribution);
      byRow.set(key, { period, groupId: slice.groupId, groupName: slice.groupName, ...figures });
      byPeriod.set(period, addToFigures(byPeriod.get(period) ?? EMPTY_FIGURES, contribution));
    }
  }

  // paymentCount counts slices under service grouping; fix it to count payments per period for the series.
  const periodCounts = new Map<string, number>();
  for (const p of payments) {
    const period = bucketStart(p.createdAt, query.granularity, query.timezone);
    periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
  }

  const series = listBuckets(range, query.granularity).map((period) => ({
    period,
    ...(byPeriod.get(period) ?? EMPTY_FIGURES),
    paymentCount: periodCounts.get(period) ?? 0,
  }));

  const rows =
    query.groupBy === "none"
      ? series.map((s) => ({ ...s, groupId: null, groupName: null }))
      : [...byRow.values()].sort(
          (a, b) =>
            a.period.localeCompare(b.period) ||
            (a.groupName ?? "").localeCompare(b.groupName ?? ""),
        );

  return {
    range,
    granularity: query.granularity,
    groupBy: query.groupBy,
    rows,
    series,
    totals: sumFigures(series),
  };
}
