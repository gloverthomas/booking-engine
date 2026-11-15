import { z } from "zod";
import { DateTime } from "luxon";
import type { Db } from "../db-types";
import { getBookingsReport } from "./bookings";
import { getCancellationsReport } from "./cancellations";
import { getClientsReport } from "./clients";
import { toCsv, type CsvColumnType } from "./csv";
import { getOutstandingReport } from "./outstanding";
import { requireAllScope, scopedStaffId, type ReportScope } from "./scope";
import { bucketLabel, defaultRange, type Granularity } from "./range";
import { getRevenueReport } from "./revenue";

/** Every table a report page shows is defined once here, so the page and its CSV export can never drift apart. */
export const REPORT_TABLE_IDS = [
  "revenue",
  "bookings-by-day",
  "utilisation",
  "busiest-weekdays",
  "busiest-hours",
  "cancellations",
  "utilisation-by-staff",
  "cancellations-by-staff",
  "top-clients",
  "lapsed-clients",
  "outstanding",
] as const;
export type ReportTableId = (typeof REPORT_TABLE_IDS)[number];

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Query string shape shared by report pages and CSV endpoints. Everything is optional. */
export const reportParamsSchema = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  granularity: z.enum(["day", "week", "month"]).default("week"),
  groupBy: z.enum(["none", "location", "service", "staff"]).default("none"),
  /** Narrow to one stylist. Ignored for people who may only see themselves (they are always scoped). */
  staff: z.string().uuid().optional(),
});
export type ReportParams = z.infer<typeof reportParamsSchema>;

export interface ReportTable {
  id: ReportTableId;
  title: string;
  /** Slug used for the download file name. */
  filename: string;
  columns: ReadonlyArray<{ key: string; header: string; type?: CsvColumnType }>;
  rows: ReadonlyArray<object>;
}

export type RawQuery = Record<string, string | string[] | undefined>;

export interface TableContext {
  timezone: string;
  now: Date;
  /** Raw query string values (page searchParams or URLSearchParams entries). Validated here. */
  query: RawQuery;
  /** Who is asking. Defaults to everyone (the pre-roles behaviour). Own-only scopes force the stylist. */
  scope?: ReportScope;
}

interface BuildContext {
  timezone: string;
  now: Date;
  params: ReportParams;
  from: string;
  to: string;
  scope: ReportScope;
  /** The stylist every query is limited to (forced for own-only scopes), or undefined for everyone. */
  staffId: string | undefined;
}

/** Fill in the default range (month to date) and validate the rest. Throws ZodError on bad input. */
export function resolveParams(
  input: RawQuery,
  timezone: string,
  now: Date,
): ReportParams & { from: string; to: string } {
  const flat = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = reportParamsSchema.parse({
    from: flat.from || undefined,
    to: flat.to || undefined,
    granularity: flat.granularity || undefined,
    groupBy: flat.groupBy || undefined,
    staff: flat.staff || undefined,
  });
  const fallback = defaultRange(now, timezone);
  return { ...parsed, from: parsed.from ?? fallback.from, to: parsed.to ?? fallback.to };
}

const localDateTime = (d: Date, tz: string): string =>
  DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-LL-dd HH:mm");
const localDay = (d: Date, tz: string): string =>
  DateTime.fromJSDate(d, { zone: tz }).toISODate() ?? "";

const STATUS_LABEL: Record<string, string> = {
  cancelled_by_client: "Cancelled by client",
  cancelled_by_staff: "Cancelled by staff",
  late_cancelled: "Late cancel",
  no_show: "No-show",
  completed: "Completed",
  confirmed: "Confirmed",
};

type Builder = (db: Db, ctx: BuildContext) => Promise<ReportTable>;

const builders: Record<ReportTableId, Builder> = {
  async revenue(db, { timezone, params, from, to, staffId }) {
    const r = await getRevenueReport(db, {
      timezone,
      from,
      to,
      granularity: params.granularity,
      groupBy: params.groupBy,
      staffId,
    });
    const groupHeader =
      params.groupBy === "service" ? "Service" : params.groupBy === "staff" ? "Stylist" : "Location";
    const columns: ReportTable["columns"] = [
      { key: "period", header: periodHeader(params.granularity) },
      ...(params.groupBy === "none" ? [] : [{ key: "group", header: groupHeader } as const]),
      { key: "depositsCents", header: "Deposits", type: "money" },
      { key: "balancesCents", header: "Balances", type: "money" },
      { key: "feeChargesCents", header: "Fees charged", type: "money" },
      { key: "grossCents", header: "Gross", type: "money" },
      { key: "refundsCents", header: "Refunds", type: "money" },
      { key: "netCents", header: "Net", type: "money" },
      { key: "feesKeptCents", header: "Fees kept", type: "money" },
    ];
    return {
      id: "revenue",
      title: "Revenue",
      filename: "revenue",
      columns,
      rows: r.rows.map((row) => ({
        ...row,
        period: bucketLabel(row.period, params.granularity),
        group: row.groupName ?? "",
      })),
    };
  },

  async "bookings-by-day"(db, { timezone, from, to, staffId }) {
    const r = await getBookingsReport(db, { timezone, from, to, staffId });
    return {
      id: "bookings-by-day",
      title: "Bookings by day",
      filename: "bookings-by-day",
      columns: [
        { key: "date", header: "Date" },
        { key: "bookings", header: "Bookings", type: "int" },
        { key: "bookedHours", header: "Booked hours", type: "decimal" },
      ],
      rows: r.byDay,
    };
  },

  async utilisation(db, { timezone, from, to, staffId }) {
    const r = await getBookingsReport(db, { timezone, from, to, staffId });
    return {
      id: "utilisation",
      title: "Utilisation by location",
      filename: "utilisation",
      columns: [
        { key: "locationName", header: "Location" },
        { key: "bookings", header: "Bookings", type: "int" },
        { key: "bookedHours", header: "Booked hours", type: "decimal" },
        { key: "availableHours", header: "Available hours", type: "decimal" },
        { key: "utilisationPct", header: "Utilisation %", type: "percent" },
      ],
      rows: r.byLocation,
    };
  },

  async "utilisation-by-staff"(db, { timezone, from, to, staffId }) {
    const r = await getBookingsReport(db, { timezone, from, to, staffId, groupBy: "staff" });
    return {
      id: "utilisation-by-staff",
      title: "Utilisation by stylist",
      filename: "utilisation-by-stylist",
      columns: [
        { key: "staffName", header: "Stylist" },
        { key: "bookings", header: "Bookings", type: "int" },
        { key: "bookedHours", header: "Booked hours", type: "decimal" },
        { key: "availableHours", header: "Rostered hours", type: "decimal" },
        { key: "utilisationPct", header: "Utilisation %", type: "percent" },
      ],
      rows: r.byStaff,
    };
  },

  async "busiest-weekdays"(db, { timezone, from, to, staffId }) {
    const r = await getBookingsReport(db, { timezone, from, to, staffId });
    return {
      id: "busiest-weekdays",
      title: "Busiest days of the week",
      filename: "busiest-weekdays",
      columns: [
        { key: "label", header: "Weekday" },
        { key: "bookings", header: "Bookings", type: "int" },
      ],
      // Monday first reads more naturally for a work week.
      rows: [...r.byWeekday.slice(1), r.byWeekday[0]],
    };
  },

  async "busiest-hours"(db, { timezone, from, to, staffId }) {
    const r = await getBookingsReport(db, { timezone, from, to, staffId });
    return {
      id: "busiest-hours",
      title: "Busiest start times",
      filename: "busiest-hours",
      columns: [
        { key: "label", header: "Start hour" },
        { key: "bookings", header: "Bookings", type: "int" },
      ],
      rows: r.byHour,
    };
  },

  async cancellations(db, { timezone, from, to, staffId }) {
    const r = await getCancellationsReport(db, { timezone, from, to, staffId });
    return {
      id: "cancellations",
      title: "Cancellations, late cancels and no-shows",
      filename: "cancellations",
      columns: [
        { key: "start", header: "Appointment" },
        { key: "statusLabel", header: "Outcome" },
        { key: "clientName", header: "Client" },
        { key: "staffName", header: "Stylist" },
        { key: "locationName", header: "Location" },
        { key: "totalCents", header: "Booking total", type: "money" },
        { key: "depositPaidCents", header: "Deposit paid", type: "money" },
        { key: "feeChargedCents", header: "Fee charged", type: "money" },
        { key: "refundedCents", header: "Refunded", type: "money" },
        { key: "keptCents", header: "Kept", type: "money" },
      ],
      rows: r.rows.map((row) => ({
        ...row,
        start: localDateTime(row.start, timezone),
        statusLabel: STATUS_LABEL[row.status] ?? row.status,
      })),
    };
  },

  async "cancellations-by-staff"(db, { timezone, from, to, staffId }) {
    const r = await getCancellationsReport(db, { timezone, from, to, staffId, groupBy: "staff" });
    return {
      id: "cancellations-by-staff",
      title: "Cancellations by stylist",
      filename: "cancellations-by-stylist",
      columns: [
        { key: "staffName", header: "Stylist" },
        { key: "scheduledCount", header: "Appointments", type: "int" },
        { key: "cancelled", header: "Cancelled in time", type: "int" },
        { key: "lateCancelled", header: "Late cancels", type: "int" },
        { key: "noShows", header: "No-shows", type: "int" },
        { key: "cancellationRatePct", header: "Rate %", type: "percent" },
        { key: "keptCents", header: "Kept", type: "money" },
        { key: "refundedCents", header: "Refunded", type: "money" },
      ],
      rows: r.byStaff,
    };
  },

  async "top-clients"(db, { timezone, from, to, now }) {
    const r = await getClientsReport(db, { timezone, from, to, now, topLimit: 50 });
    return {
      id: "top-clients",
      title: "Top clients by spend",
      filename: "top-clients",
      columns: [
        { key: "name", header: "Client" },
        { key: "email", header: "Email" },
        { key: "visits", header: "Visits", type: "int" },
        { key: "spendCents", header: "Spend", type: "money" },
        { key: "lastVisit", header: "Last visit" },
      ],
      rows: r.topClients.map((c) => ({
        ...c,
        lastVisit: c.lastVisit ? localDay(c.lastVisit, timezone) : "",
      })),
    };
  },

  async "lapsed-clients"(db, { timezone, from, to, now }) {
    const r = await getClientsReport(db, { timezone, from, to, now, lapsedLimit: 1000 });
    return {
      id: "lapsed-clients",
      title: `Lapsed clients (no visit in ${r.lapsed.thresholdDays}+ days)`,
      filename: "lapsed-clients",
      columns: [
        { key: "name", header: "Client" },
        { key: "email", header: "Email" },
        { key: "phone", header: "Phone" },
        { key: "lastVisit", header: "Last visit" },
        { key: "daysSinceLastVisit", header: "Days since", type: "int" },
        { key: "lifetimeVisits", header: "Visits", type: "int" },
      ],
      rows: r.lapsed.rows.map((c) => ({ ...c, lastVisit: localDay(c.lastVisit, timezone) })),
    };
  },

  async outstanding(db, { timezone, now }) {
    const r = await getOutstandingReport(db, { now });
    return {
      id: "outstanding",
      title: "Outstanding balances",
      filename: "outstanding-balances",
      columns: [
        { key: "start", header: "Appointment" },
        { key: "stateLabel", header: "State" },
        { key: "clientName", header: "Client" },
        { key: "clientPhone", header: "Phone" },
        { key: "locationName", header: "Location" },
        { key: "totalCents", header: "Total", type: "money" },
        { key: "paidCents", header: "Paid", type: "money" },
        { key: "outstandingCents", header: "Outstanding", type: "money" },
      ],
      rows: r.rows.map((row) => ({
        ...row,
        start: localDateTime(row.start, timezone),
        stateLabel: row.state === "overdue" ? "Overdue" : "Due at appointment",
      })),
    };
  },
};

/** Tables about every client or every balance: not split by stylist, so only for roles that see everyone. */
const BUSINESS_WIDE: ReadonlySet<ReportTableId> = new Set(["top-clients", "lapsed-clients", "outstanding"]);

export function isBusinessWideTable(id: ReportTableId): boolean {
  return BUSINESS_WIDE.has(id);
}

function periodHeader(granularity: Granularity): string {
  return granularity === "day" ? "Day" : granularity === "week" ? "Week" : "Month";
}

export function isReportTableId(value: string): value is ReportTableId {
  return (REPORT_TABLE_IDS as readonly string[]).includes(value);
}

/** Build one report table (columns + rows) for a page or CSV download. */
export async function buildReportTable(
  db: Db,
  id: ReportTableId,
  ctx: TableContext,
): Promise<ReportTable> {
  const params = resolveParams(ctx.query, ctx.timezone, ctx.now);
  const scope: ReportScope = ctx.scope ?? { kind: "all" };
  // Whole-business tables are never built for someone who may only see their own numbers.
  if (BUSINESS_WIDE.has(id)) requireAllScope(scope);
  return builders[id](db, {
    timezone: ctx.timezone,
    now: ctx.now,
    params,
    from: params.from,
    to: params.to,
    scope,
    // An own-only scope overrides whatever `staff` the URL asked for.
    staffId: scopedStaffId(scope, params.staff),
  });
}

/** Render a table as CSV text (see csv.ts for escaping and formula-injection guards). */
export function tableToCsv(table: ReportTable): string {
  return toCsv(table.columns, table.rows as ReadonlyArray<Record<string, unknown>>);
}
