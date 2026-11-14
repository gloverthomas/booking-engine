import { z } from "zod";
import { DateTime } from "luxon";
import { defineRead } from "../deps";
import { McpToolError, callBackend } from "../errors";
import { getCancellationsReport } from "../../reports/cancellations";
import { defaultRange } from "../../reports/range";
import { getRevenueReport } from "../../reports/revenue";
import { dollars, idSchema, localDateSchema, localDateOfInstant, whenOut } from "../shared";
import { personName, untrusted } from "../text";

const MAX_AVAILABILITY_DAYS = 14;
const MAX_SLOTS_RETURNED = 200;

export const checkAvailability = defineRead({
  kind: "read",
  name: "check_availability",
  title: "Check availability",
  description:
    "Open appointment start times at a location for a set of services, between two dates (at most 14 days). " +
    "Uses the same rules as online booking: opening hours, time off, existing bookings and booking limits.",
  schema: z.object({
    locationId: idSchema,
    serviceIds: z.array(idSchema).min(1).max(10),
    fromDate: localDateSchema,
    toDate: localDateSchema,
    staffId: idSchema.optional().describe("Omit for any stylist."),
  }),
  async run(args, { deps, timezone }) {
    const from = DateTime.fromISO(args.fromDate, { zone: timezone });
    const to = DateTime.fromISO(args.toDate, { zone: timezone });
    if (!from.isValid || !to.isValid || to < from) {
      throw new McpToolError(
        "invalid_input",
        "fromDate and toDate must be real dates, toDate not before fromDate.",
      );
    }
    if (to.diff(from, "days").days + 1 > MAX_AVAILABILITY_DAYS) {
      throw new McpToolError(
        "invalid_input",
        `Check at most ${MAX_AVAILABILITY_DAYS} days at a time.`,
      );
    }
    const slots = await callBackend(() =>
      deps.services.getAvailableSlots(deps.db, {
        locationId: args.locationId,
        staffId: args.staffId,
        serviceIds: args.serviceIds,
        fromDate: args.fromDate,
        toDate: args.toDate,
        now: deps.now(),
      }),
    );
    const byDate = new Map<string, string[]>();
    for (const slot of slots.slice(0, MAX_SLOTS_RETURNED)) {
      const date = localDateOfInstant(slot.start, timezone);
      byDate.set(date, [...(byDate.get(date) ?? []), whenOut(slot.start, timezone).local]);
    }
    return {
      totalSlots: slots.length,
      truncated: slots.length > MAX_SLOTS_RETURNED,
      days: [...byDate].map(([date, starts]) => ({ date, starts })),
      slots: slots.slice(0, MAX_SLOTS_RETURNED).map((s) => ({
        staffId: s.staffId,
        start: whenOut(s.start, timezone),
        end: whenOut(s.end, timezone),
      })),
    };
  },
});

const rangeFields = {
  from: localDateSchema
    .optional()
    .describe("First day, YYYY-MM-DD. Defaults to the start of this month."),
  to: localDateSchema.optional().describe("Last day, YYYY-MM-DD. Defaults to today."),
};

export const getRevenueSummary = defineRead({
  kind: "read",
  name: "get_revenue_summary",
  title: "Get revenue summary",
  description:
    "Money received between two dates (business timezone), by day, week or month and optionally by location or " +
    "service: deposits, balances, fees charged, refunds, net, and fees kept from late cancels and no-shows. " +
    "All amounts are in cents (AUD).",
  schema: z.object({
    ...rangeFields,
    granularity: z.enum(["day", "week", "month"]).default("week"),
    groupBy: z.enum(["none", "location", "service"]).default("none"),
  }),
  async run(args, { deps, timezone }) {
    const fallback = defaultRange(deps.now(), timezone);
    const report = await getRevenueReport(deps.db, {
      timezone,
      from: args.from ?? fallback.from,
      to: args.to ?? fallback.to,
      granularity: args.granularity,
      groupBy: args.groupBy,
    });
    const t = report.totals;
    return {
      from: report.range.fromDate,
      to: report.range.toDate,
      granularity: report.granularity,
      groupBy: report.groupBy,
      totals: t,
      totalsFormatted: {
        gross: dollars(t.grossCents),
        refunds: dollars(t.refundsCents),
        net: dollars(t.netCents),
        feesKept: dollars(t.feesKeptCents),
      },
      rows: report.rows.slice(0, 200),
      rowsTruncated: report.rows.length > 200,
    };
  },
});

export const getCancellationReport = defineRead({
  kind: "read",
  name: "get_cancellation_report",
  title: "Get cancellation report",
  description:
    "Cancellations, late cancels and no-shows for appointments between two dates, with the rate and the dollars " +
    "kept from deposits and fees. Amounts in cents (AUD).",
  schema: z.object({
    ...rangeFields,
    limit: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(30)
      .describe("Most recent incidents to list. 0 for totals only."),
  }),
  async run(args, { deps, timezone }) {
    const fallback = defaultRange(deps.now(), timezone);
    const report = await getCancellationsReport(deps.db, {
      timezone,
      from: args.from ?? fallback.from,
      to: args.to ?? fallback.to,
    });
    return {
      from: report.range.fromDate,
      to: report.range.toDate,
      counts: report.counts,
      scheduledAppointments: report.scheduledCount,
      cancellationRatePct: report.cancellationRatePct,
      keptCents: report.keptCents,
      keptFormatted: dollars(report.keptCents),
      refundedCents: report.refundedCents,
      incidents: report.rows.slice(0, args.limit).map((r) => ({
        bookingId: r.bookingId,
        appointment: whenOut(r.start, timezone),
        outcome: r.status,
        location: r.locationName,
        client: { id: r.clientId, name: untrusted(r.clientName || personName("", ""), 120) },
        totalCents: r.totalCents,
        depositPaidCents: r.depositPaidCents,
        feeChargedCents: r.feeChargedCents,
        refundedCents: r.refundedCents,
        keptCents: r.keptCents,
        reason: untrusted(r.cancelReason, 300),
      })),
      incidentsTruncated: report.rows.length > args.limit,
    };
  },
});
