import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { location, service } from "@/db/schema";
import { getBusinessSettings } from "../../settings";
import type { ClientInput } from "../../contracts";
import { defineWrite, type ToolContext } from "../deps";
import { McpToolError, callBackend } from "../errors";
import { loadBookingDetail, loadClient } from "../queries";
import { dollars, idSchema, localDateOfInstant, parseWhen, whenOut, whenSchema } from "../shared";
import { personName, quoted, untrusted } from "../text";

const MS_PER_HOUR = 3_600_000;

/** Best effort: is `start` one of the slots the booking engine would offer? Never blocks, only informs. */
async function checkSlot(
  ctx: ToolContext,
  input: { locationId: string; staffId?: string; serviceIds: string[]; start: Date },
): Promise<"available" | "not_offered" | "unverified"> {
  try {
    const day = localDateOfInstant(input.start, ctx.timezone);
    const slots = await ctx.deps.services.getAvailableSlots(ctx.deps.db, {
      locationId: input.locationId,
      staffId: input.staffId,
      serviceIds: input.serviceIds,
      fromDate: day,
      toDate: day,
      now: ctx.deps.now(),
    });
    return slots.some((s) => s.start.getTime() === input.start.getTime())
      ? "available"
      : "not_offered";
  } catch {
    return "unverified";
  }
}

const SLOT_NOTE: Record<string, string> = {
  available: "That time is an open slot.",
  not_offered:
    "Warning: that start time is not one of the slots online booking would offer (outside hours, time off or already taken). The booking system will refuse it if it conflicts.",
  unverified: "Availability could not be checked beforehand; the booking system will validate it.",
};

/* ------------------------------ create_booking ----------------------------- */

const newClientSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).default(""),
  email: z.string().trim().max(200).pipe(z.email()),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(30)
    .describe("Australian mobile or landline; international numbers need +."),
  pronouns: z.string().trim().max(40).optional(),
  marketingOptIn: z.boolean().default(false),
});

const createBookingSchema = z
  .object({
    locationId: idSchema,
    staffId: idSchema.optional().describe("Omit for the first available stylist."),
    serviceIds: z.array(idSchema).min(1).max(10),
    start: whenSchema,
    clientId: idSchema.optional().describe("An existing client. Use find_client to get the id."),
    client: newClientSchema
      .optional()
      .describe("Details for a new client. Give this or clientId, not both."),
    comments: z.string().trim().max(500).optional().describe("Note stored on the booking."),
  })
  .refine((a) => Boolean(a.clientId) !== Boolean(a.client), {
    message: "Provide exactly one of clientId or client.",
  });

async function resolveClient(
  ctx: ToolContext,
  args: z.infer<typeof createBookingSchema>,
): Promise<{ input: ClientInput; label: string; existing: boolean }> {
  if (args.clientId) {
    const c = await loadClient(ctx.deps.db, args.clientId);
    if (c.mergedIntoId) {
      throw new McpToolError(
        "precondition_failed",
        "That client record was merged into another one. Use the merged client's id.",
        {
          mergedInto: c.mergedIntoId,
        },
      );
    }
    if (c.blocked)
      throw new McpToolError("precondition_failed", "That client is blocked from booking.");
    if (!c.email || !c.phone) {
      throw new McpToolError(
        "invalid_input",
        "That client has no email or no phone on file. Pass the full details in `client` instead (or add them first).",
      );
    }
    return {
      existing: true,
      label: personName(c.firstName, c.lastName),
      input: {
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        pronouns: c.pronouns ?? undefined,
        marketingOptIn: c.marketingOptIn,
      },
    };
  }
  const n = args.client!;
  const phone = parsePhoneNumberFromString(n.phone, "AU");
  if (!phone?.isValid()) {
    throw new McpToolError(
      "invalid_input",
      "That phone number is not valid. Use a full Australian number or +country code.",
    );
  }
  return {
    existing: false,
    label: personName(n.firstName, n.lastName),
    input: {
      firstName: n.firstName,
      lastName: n.lastName,
      email: n.email,
      phone: phone.number,
      pronouns: n.pronouns,
      marketingOptIn: n.marketingOptIn,
    },
  };
}

export const createBookingTool = defineWrite({
  kind: "write",
  name: "create_booking",
  title: "Create booking",
  description:
    "Book a client in (for example after a phone call). Previews first. Once confirmed the booking is confirmed " +
    "immediately with no online deposit, and the usual confirmation messages go out.",
  schema: createBookingSchema,
  destructive: false,
  entityType: "booking",
  auditArgs: (a) => ({
    locationId: a.locationId,
    staffId: a.staffId,
    serviceIds: a.serviceIds,
    start: a.start,
    clientId: a.clientId,
    newClient: Boolean(a.client),
  }),
  async prepare(args, ctx) {
    const start = parseWhen(args.start, ctx.timezone, "start");
    if (start.getTime() <= ctx.deps.now().getTime()) {
      throw new McpToolError("invalid_input", "start must be in the future.");
    }
    const unique = [...new Set(args.serviceIds)];
    const services = await ctx.deps.db
      .select()
      .from(service)
      .where(and(inArray(service.id, unique), eq(service.active, true)));
    if (services.length !== unique.length) {
      throw new McpToolError("not_found", "One or more services do not exist or are switched off.");
    }
    const [loc] = await ctx.deps.db.select().from(location).where(eq(location.id, args.locationId));
    if (!loc?.active)
      throw new McpToolError("not_found", "That location does not exist or is not active.");
    const client = await resolveClient(ctx, args);
    const slot = await checkSlot(ctx, { ...args, serviceIds: unique, start });
    const durationMin = services.reduce((s, x) => s + x.durationMin, 0);
    const totalCents = services.reduce((s, x) => s + x.priceCents, 0);
    const when = whenOut(start, ctx.timezone);
    return {
      summary:
        `Create a confirmed booking for ${quoted(client.label)} (${client.existing ? "existing client" : "NEW client"}) ` +
        `at ${loc.name} on ${when.local}: ${services.map((s) => `${s.name} (${dollars(s.priceCents)})`).join(", ")}. ` +
        `About ${durationMin} minutes, estimated total ${dollars(totalCents)}. No online deposit is collected. ${SLOT_NOTE[slot]}`,
      details: {
        client: { name: untrusted(client.label, 120), existing: client.existing },
        location: loc.name,
        start: when,
        services: services.map((s) => ({
          name: s.name,
          durationMin: s.durationMin,
          priceCents: s.priceCents,
        })),
        estimatedTotalCents: totalCents,
        depositCollected: false,
        comments: untrusted(args.comments ?? null, 500),
        availabilityCheck: slot,
      },
    };
  },
  async execute(args, ctx) {
    const start = parseWhen(args.start, ctx.timezone, "start");
    const client = await resolveClient(ctx, args);
    const settings = await getBusinessSettings(ctx.deps.db, ctx.businessId);
    const now = ctx.deps.now();
    const hold = await callBackend(() =>
      ctx.deps.services.createHold(ctx.deps.db, {
        locationId: args.locationId,
        staffId: args.staffId,
        serviceIds: [...new Set(args.serviceIds)],
        start,
        client: client.input,
        comments: args.comments,
        policyVersion: settings.policyVersion,
        source: "mcp",
        now,
      }),
    );
    try {
      await callBackend(() => ctx.deps.services.confirmBooking(ctx.deps.db, hold.bookingId, now));
    } catch (error) {
      throw new McpToolError(
        "backend_error",
        "The slot was held but the booking could not be confirmed. The hold will lapse on its own.",
        {
          bookingId: hold.bookingId,
          cause: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        },
      );
    }
    return {
      summary: `Booked ${quoted(client.label)} for ${whenOut(hold.during.start, ctx.timezone).local}.`,
      entityId: hold.bookingId,
      result: {
        bookingId: hold.bookingId,
        status: "confirmed",
        start: whenOut(hold.during.start, ctx.timezone),
        end: whenOut(hold.during.end, ctx.timezone),
        totalCents: hold.totalCents,
        depositCents: hold.depositCents,
      },
    };
  },
});

/* -------------------------------- move_booking ------------------------------ */

const moveSchema = z.object({
  bookingId: idSchema,
  newStart: whenSchema,
  notifyClient: z.boolean().default(true).describe("Send the client a 'booking moved' message."),
});

const MOVABLE = ["confirmed", "pending_payment"];

export const moveBookingTool = defineWrite({
  kind: "write",
  name: "move_booking",
  title: "Move booking",
  description:
    "Reschedule a booking to a new start time, optionally telling the client. Previews first.",
  schema: moveSchema,
  destructive: false,
  entityType: "booking",
  auditArgs: (a) => ({ newStart: a.newStart, notifyClient: a.notifyClient }),
  async prepare(args, ctx) {
    const d = await loadBookingDetail(ctx.deps.db, args.bookingId);
    if (!MOVABLE.includes(d.b.status)) {
      throw new McpToolError(
        "precondition_failed",
        `Only confirmed bookings can be moved; this one is ${d.b.status}.`,
      );
    }
    const newStart = parseWhen(args.newStart, ctx.timezone, "newStart");
    if (newStart.getTime() <= ctx.deps.now().getTime()) {
      throw new McpToolError("invalid_input", "newStart must be in the future.");
    }
    if (newStart.getTime() === d.b.during.start.getTime()) {
      throw new McpToolError("invalid_input", "The booking is already at that time.");
    }
    const slot = await checkSlot(ctx, {
      locationId: d.b.locationId,
      staffId: d.b.staffId,
      serviceIds: d.services.flatMap((s) => (s.serviceId ? [s.serviceId] : [])),
      start: newStart,
    });
    const from = whenOut(d.b.during.start, ctx.timezone);
    const to = whenOut(newStart, ctx.timezone);
    const name = personName(d.client.firstName, d.client.lastName);
    return {
      summary:
        `Move ${quoted(name)}'s booking at ${d.locationName} from ${from.local} to ${to.local}. ` +
        `${args.notifyClient ? "The client will be notified." : "The client will NOT be notified."} ${SLOT_NOTE[slot]}`,
      details: {
        bookingId: d.b.id,
        client: { id: d.client.id, name: untrusted(name, 120) },
        from,
        to,
        notifyClient: args.notifyClient,
        availabilityCheck: slot,
      },
    };
  },
  async execute(args, ctx) {
    const newStart = parseWhen(args.newStart, ctx.timezone, "newStart");
    await callBackend(() =>
      ctx.deps.services.rescheduleBooking(ctx.deps.db, {
        bookingId: args.bookingId,
        newStart,
        by: "staff",
        notifyClient: args.notifyClient,
        now: ctx.deps.now(),
      }),
    );
    return {
      summary: `Moved the booking to ${whenOut(newStart, ctx.timezone).local}.`,
      entityId: args.bookingId,
      result: {
        bookingId: args.bookingId,
        newStart: whenOut(newStart, ctx.timezone),
        notified: args.notifyClient,
      },
    };
  },
});

/* ------------------------------- cancel_booking ----------------------------- */

const cancelSchema = z.object({
  bookingId: idSchema,
  reason: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe("Why it is being cancelled. Stored on the booking."),
  depositOutcome: z
    .enum(["refund", "policy"])
    .default("refund")
    .describe(
      "refund: always give the deposit back. policy: let the cancellation policy decide (late cancels forfeit).",
    ),
});

export const cancelBookingTool = defineWrite({
  kind: "write",
  name: "cancel_booking",
  title: "Cancel booking",
  description:
    "Cancel a booking on the client's or the business's behalf, with the deposit refunded or handled by policy. " +
    "Previews first. This frees the slot and notifies the client.",
  schema: cancelSchema,
  destructive: true,
  entityType: "booking",
  auditArgs: (a) => ({ depositOutcome: a.depositOutcome, hasReason: Boolean(a.reason) }),
  async prepare(args, ctx) {
    const d = await loadBookingDetail(ctx.deps.db, args.bookingId);
    if (!MOVABLE.includes(d.b.status)) {
      throw new McpToolError(
        "precondition_failed",
        `Only confirmed bookings can be cancelled; this one is ${d.b.status}.`,
      );
    }
    const settings = await getBusinessSettings(ctx.deps.db, ctx.businessId);
    const deposit = d.payments
      .filter((p) => p.kind === "deposit" && ["succeeded", "partially_refunded"].includes(p.status))
      .reduce((s, p) => s + p.amountCents, 0);
    const hoursAway = (d.b.during.start.getTime() - ctx.deps.now().getTime()) / MS_PER_HOUR;
    const inside = hoursAway < settings.cancelWindowHours;
    const name = personName(d.client.firstName, d.client.lastName);
    const when = whenOut(d.b.during.start, ctx.timezone);
    const depositLine =
      deposit === 0
        ? "No deposit has been paid."
        : args.depositOutcome === "refund"
          ? `The ${dollars(deposit)} deposit will be refunded.`
          : inside
            ? `This is inside the ${settings.cancelWindowHours}h window, so policy keeps the ${dollars(deposit)} deposit.`
            : `This is outside the ${settings.cancelWindowHours}h window, so policy refunds the ${dollars(deposit)} deposit.`;
    return {
      summary: `CANCEL ${quoted(name)}'s booking at ${d.locationName} on ${when.local}. ${depositLine} The client will be notified.`,
      details: {
        bookingId: d.b.id,
        client: { id: d.client.id, name: untrusted(name, 120) },
        start: when,
        depositPaidCents: deposit,
        depositOutcome: args.depositOutcome,
        insideCancelWindow: inside,
        hoursUntilStart: Math.round(hoursAway * 10) / 10,
        reason: untrusted(args.reason ?? null, 300),
      },
    };
  },
  async execute(args, ctx) {
    const outcome = await callBackend(() =>
      ctx.deps.services.cancelBooking(ctx.deps.db, {
        bookingId: args.bookingId,
        by: "staff",
        reason: args.reason,
        forceRefund: args.depositOutcome === "refund",
        now: ctx.deps.now(),
      }),
    );
    return {
      summary: `Cancelled the booking (${outcome.status}). Deposit action: ${outcome.depositAction}.`,
      entityId: args.bookingId,
      result: {
        bookingId: outcome.bookingId,
        status: outcome.status,
        depositAction: outcome.depositAction,
        feeCents: outcome.feeCents,
        feeNote:
          outcome.feeCents > 0
            ? "A fee is due on the saved card. Use charge_no_show_fee to take it (needs the money tools enabled)."
            : null,
      },
    };
  },
});
