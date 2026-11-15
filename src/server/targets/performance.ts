import { staff, staffTarget } from "@/db/schema";
import type { Db } from "../db-types";
import { getBookingsReport } from "../reports/bookings";
import { getRevenueReport } from "../reports/revenue";
import { resolveRange } from "../reports/range";
import { scopedStaffId, type ReportScope } from "../reports/scope";
import { getRebookCounts, type RebookCounts } from "./rebook";
import {
  elapsedPct,
  periodEnded,
  periodRange,
  pickTarget,
  progressOf,
  type PeriodRange,
  type Progress,
  type TargetPeriod,
} from "./progress";
import type { TargetMetric } from "./units";

export interface MetricResult {
  /** Revenue in cents, a count, or basis points (10000 = 100%). Null when there is nothing to measure. */
  actual: number | null;
  /** The target in force for this person, metric and period, in the same unit. */
  target: number | null;
  progress: Progress | null;
}

export interface PerformanceRow {
  /** Null for the whole-business row. */
  staffId: string | null;
  name: string;
  revenue: MetricResult;
  bookings: MetricResult;
  utilisation: MetricResult;
  rebookRate: MetricResult;
  detail: {
    bookedHours: number;
    rosteredHours: number;
    rebookEligible: number;
    rebooked: number;
  };
}

export interface PerformanceReport {
  range: PeriodRange;
  /** Percentage of the period that has gone by. */
  elapsedPct: number;
  ended: boolean;
  /** One row per stylist the signed-in person may see. */
  rows: PerformanceRow[];
  /** The whole business. Only for roles that see everyone. */
  business: PerformanceRow | null;
}

export interface PerformanceQuery {
  timezone: string;
  period: TargetPeriod;
  /** Any local date inside the wanted period. Default: today. */
  anchorDate?: string;
  /** Who is asking. Own-only scopes get only their own row, whatever else is requested. */
  scope: ReportScope;
  now: Date;
}

const bps = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 10_000) : null;

function rateBps(counts: RebookCounts | undefined): number | null {
  return counts ? bps(counts.rebooked, counts.eligible) : null;
}

/** Actual vs target for each stylist for the chosen week or month. Revenue is cash basis, as in the reports. */
export async function getPerformance(db: Db, query: PerformanceQuery): Promise<PerformanceReport> {
  const onlyStaffId = scopedStaffId(query.scope); // throws for a scope of "none"
  const range = periodRange(query.period, query.timezone, query.now, query.anchorDate);
  const resolved = resolveRange(query.timezone, range.from, range.to);
  const elapsed = elapsedPct(range, query.timezone, query.now);
  const ended = periodEnded(range, query.timezone, query.now);

  const [revenue, bookings, rebook, people, targets] = await Promise.all([
    getRevenueReport(db, {
      timezone: query.timezone,
      from: range.from,
      to: range.to,
      granularity: "month",
      groupBy: "staff",
      staffId: onlyStaffId,
    }),
    getBookingsReport(db, {
      timezone: query.timezone,
      from: range.from,
      to: range.to,
      groupBy: "staff",
      staffId: onlyStaffId,
    }),
    getRebookCounts(db, { range: resolved, now: query.now, staffId: onlyStaffId }),
    db
      .select({ id: staff.id, name: staff.name, role: staff.role, active: staff.active })
      .from(staff),
    db.select().from(staffTarget),
  ]);

  const revenueByStaff = new Map<string, number>();
  for (const row of revenue.rows) {
    if (!row.groupId) continue;
    revenueByStaff.set(row.groupId, (revenueByStaff.get(row.groupId) ?? 0) + row.netCents);
  }
  const bookingRows = new Map(bookings.byStaff.map((b) => [b.staffId, b]));

  const metric = (
    staffId: string | null,
    kind: TargetMetric,
    actual: number | null,
  ): MetricResult => {
    const target = pickTarget(targets, { staffId, metric: kind, range })?.targetValue ?? null;
    return {
      actual,
      target,
      progress: target === null ? null : progressOf(actual, target, elapsed, ended),
    };
  };

  const rowFor = (
    staffId: string | null,
    name: string,
    figures: {
      revenueCents: number;
      bookings: number;
      bookedHours: number;
      rosteredHours: number;
      rebook: RebookCounts | undefined;
    },
  ): PerformanceRow => ({
    staffId,
    name,
    revenue: metric(staffId, "revenue", figures.revenueCents),
    bookings: metric(staffId, "bookings", figures.bookings),
    utilisation: metric(staffId, "utilisation", bps(figures.bookedHours, figures.rosteredHours)),
    rebookRate: metric(staffId, "rebook_rate", rateBps(figures.rebook)),
    detail: {
      bookedHours: figures.bookedHours,
      rosteredHours: figures.rosteredHours,
      rebookEligible: figures.rebook?.eligible ?? 0,
      rebooked: figures.rebook?.rebooked ?? 0,
    },
  });

  // Stylists: everyone who is on the books as someone who takes appointments, plus anyone with activity.
  const rows = people
    .filter((p) => (onlyStaffId ? p.id === onlyStaffId : true))
    .filter(
      (p) =>
        (p.active && p.role !== "reception") ||
        bookingRows.has(p.id) ||
        revenueByStaff.has(p.id) ||
        onlyStaffId === p.id,
    )
    .map((p) => {
      const b = bookingRows.get(p.id);
      return rowFor(p.id, p.name, {
        revenueCents: revenueByStaff.get(p.id) ?? 0,
        bookings: b?.bookings ?? 0,
        bookedHours: b?.bookedHours ?? 0,
        rosteredHours: b?.availableHours ?? 0,
        rebook: rebook.byStaff.get(p.id),
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const business =
    query.scope.kind === "all"
      ? rowFor(null, "Whole business", {
          revenueCents: revenue.totals.netCents,
          bookings: bookings.bookedCount,
          bookedHours: bookings.bookedHours,
          rosteredHours: bookings.availableHours,
          rebook: rebook.total,
        })
      : null;

  return { range, elapsedPct: elapsed, ended, rows, business };
}
