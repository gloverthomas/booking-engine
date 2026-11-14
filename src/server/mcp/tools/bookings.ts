import { z } from "zod";
import { DateTime } from "luxon";
import { defineRead } from "../deps";
import { McpToolError } from "../errors";
import { loadBookingDetail, queryBookings } from "../queries";
import { addDaysLocal, idSchema, localDateSchema, todayLocal, whenOut } from "../shared";
import { personName, untrusted } from "../text";

const STATUSES = [
  "pending_payment",
  "confirmed",
  "completed",
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
  "no_show",
  "expired",
] as const;

const listBookingsSchema = z.object({
  from: localDateSchema.optional().describe("First day to include, YYYY-MM-DD. Defaults to today."),
  to: localDateSchema
    .optional()
    .describe("Last day to include, YYYY-MM-DD. Defaults to 6 days after from."),
  locationId: idSchema.optional(),
  status: z
    .array(z.enum(STATUSES))
    .max(8)
    .optional()
    .describe("Only these statuses. Default: all."),
  limit: z.number().int().min(1).max(100).default(50),
});

export const listBookings = defineRead({
  kind: "read",
  name: "list_bookings",
  title: "List bookings",
  description:
    "List appointments starting between two dates (business timezone), optionally for one location or status. " +
    "Returns time, client, services, status and amounts, oldest first.",
  schema: listBookingsSchema,
  async run(args, { deps, timezone }) {
    const from = args.from ?? todayLocal(deps.now(), timezone);
    const to = args.to ?? addDaysLocal(from, 6, timezone);
    const start = DateTime.fromISO(from, { zone: timezone });
    const end = DateTime.fromISO(to, { zone: timezone });
    if (!start.isValid || !end.isValid || end < start) {
      throw new McpToolError(
        "invalid_input",
        "from and to must be real dates, with to on or after from.",
      );
    }
    if (end.diff(start, "days").days > 92) {
      throw new McpToolError("invalid_input", "List at most 93 days at a time.");
    }
    const { rows, hasMore } = await queryBookings(deps.db, {
      from: start.startOf("day").toJSDate(),
      to: end.plus({ days: 1 }).startOf("day").toJSDate(),
      locationId: args.locationId,
      statuses: args.status,
      limit: args.limit,
    });
    return {
      from,
      to,
      count: rows.length,
      hasMore,
      bookings: rows.map((r) => ({
        bookingId: r.bookingId,
        status: r.status,
        start: whenOut(r.start, timezone),
        end: whenOut(r.end, timezone),
        location: { id: r.locationId, name: r.locationName },
        client: { id: r.clientId, name: untrusted(personName(r.firstName, r.lastName), 120) },
        services: r.services,
        totalCents: r.totalCents,
        depositCents: r.depositCents,
      })),
    };
  },
});

export const getBooking = defineRead({
  kind: "read",
  name: "get_booking",
  title: "Get booking",
  description:
    "Full detail for one booking: client, services, payments, message history and any client comments or notes.",
  schema: z.object({ bookingId: idSchema }),
  async run({ bookingId }, { deps, timezone }) {
    const d = await loadBookingDetail(deps.db, bookingId);
    return {
      bookingId: d.b.id,
      status: d.b.status,
      start: whenOut(d.b.during.start, timezone),
      end: whenOut(d.b.during.end, timezone),
      location: { id: d.b.locationId, name: d.locationName },
      stylist: { id: d.b.staffId, name: d.staffName },
      client: {
        id: d.client.id,
        name: untrusted(personName(d.client.firstName, d.client.lastName), 120),
        email: untrusted(d.client.email, 200),
        phone: untrusted(d.client.phone, 40),
        isVip: d.client.isVip,
        blocked: d.client.blocked,
      },
      services: d.services.map((s) => ({
        name: s.name,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
      })),
      totalCents: d.b.totalCents,
      depositCents: d.b.depositCents,
      source: d.b.source,
      bookedForSomeoneElse: d.b.bookedForOther,
      clientComments: untrusted(d.b.comments, 1000),
      // Keys come from the booking form too, so they are wrapped like the answers.
      intakeAnswers: Object.entries(d.b.intakeAnswers)
        .slice(0, 20)
        .map(([question, answer]) => ({
          question: untrusted(question, 80),
          answer: untrusted(answer, 300),
        })),
      cancelReason: untrusted(d.b.cancelReason, 300),
      cancelledAt: d.b.cancelledAt ? whenOut(d.b.cancelledAt, timezone) : null,
      payments: d.payments.map((p) => ({
        paymentId: p.id,
        kind: p.kind,
        method: p.method,
        status: p.status,
        amountCents: p.amountCents,
        at: whenOut(p.createdAt, timezone),
      })),
      messages: d.messages.map((m) => ({
        channel: m.channel,
        template: m.template,
        status: m.status,
        at: whenOut(m.createdAt, timezone),
      })),
    };
  },
});
