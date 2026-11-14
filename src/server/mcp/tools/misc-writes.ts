import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { booking, client, service, staff, timeBlock } from "@/db/schema";
import { SLOT_HOLDING_STATUSES } from "@/db/schema";
import { defineWrite } from "../deps";
import { McpToolError, callBackend } from "../errors";
import { loadClient } from "../queries";
import { dollars, idSchema, parseWhen, whenOut, whenSchema } from "../shared";
import { personName, quoted, untrusted } from "../text";

const MS_PER_DAY = 86_400_000;

/* -------------------------------- block_time -------------------------------- */

const blockSchema = z.object({
  staffId: idSchema.optional().describe("Omit when there is only one active stylist."),
  start: whenSchema,
  end: whenSchema,
  reason: z.string().trim().max(200).optional().describe("Shown only to you, e.g. 'Dentist'."),
});

export const blockTimeTool = defineWrite({
  kind: "write",
  name: "block_time",
  title: "Block time",
  description:
    "Mark time as unavailable (leave, an appointment elsewhere) so it cannot be booked online. Previews first, " +
    "including any existing bookings in that window (these are not moved or cancelled).",
  schema: blockSchema,
  destructive: false,
  entityType: "time_block",
  auditArgs: (a) => ({ staffId: a.staffId, start: a.start, end: a.end }),
  async prepare(args, ctx) {
    const start = parseWhen(args.start, ctx.timezone, "start");
    const end = parseWhen(args.end, ctx.timezone, "end");
    if (end <= start) throw new McpToolError("invalid_input", "end must be after start.");
    if (end.getTime() - start.getTime() > 31 * MS_PER_DAY) {
      throw new McpToolError("invalid_input", "Block at most 31 days at a time.");
    }
    const stylists = await ctx.deps.db
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(args.staffId ? eq(staff.id, args.staffId) : eq(staff.active, true));
    if (stylists.length === 0) throw new McpToolError("not_found", "No such stylist.");
    if (stylists.length > 1) {
      throw new McpToolError(
        "invalid_input",
        "There is more than one stylist. Say which one with staffId.",
        {
          stylists: stylists.map((s) => ({ staffId: s.id, name: s.name })),
        },
      );
    }
    const [stylist] = stylists;
    const clashes = await ctx.deps.db
      .select({ id: booking.id, during: booking.during })
      .from(booking)
      .where(
        and(
          eq(booking.staffId, stylist.id),
          inArray(booking.status, [...SLOT_HOLDING_STATUSES]),
          sql`${booking.during} && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')`,
        ),
      );
    const from = whenOut(start, ctx.timezone);
    const to = whenOut(end, ctx.timezone);
    return {
      summary:
        `Block ${stylist.name}'s time from ${from.local} to ${to.local}` +
        `${args.reason ? ` (reason: ${quoted(args.reason, 200)})` : ""}. ` +
        (clashes.length > 0
          ? `Warning: ${clashes.length} existing booking(s) fall in this window and will NOT be moved or cancelled.`
          : "No existing bookings fall in this window."),
      details: {
        stylist: { id: stylist.id, name: stylist.name },
        start: from,
        end: to,
        reason: untrusted(args.reason ?? null, 200),
        clashingBookings: clashes.map((c) => ({
          bookingId: c.id,
          start: whenOut(c.during.start, ctx.timezone),
        })),
      },
    };
  },
  async execute(args, ctx) {
    const start = parseWhen(args.start, ctx.timezone, "start");
    const end = parseWhen(args.end, ctx.timezone, "end");
    const [stylist] = await ctx.deps.db
      .select({ id: staff.id })
      .from(staff)
      .where(args.staffId ? eq(staff.id, args.staffId) : eq(staff.active, true))
      .limit(1);
    const [row] = await ctx.deps.db
      .insert(timeBlock)
      .values({
        staffId: stylist.id,
        during: { start, end },
        reason: args.reason ?? null,
        source: "manual",
      })
      .returning({ id: timeBlock.id });
    return {
      summary: `Blocked ${whenOut(start, ctx.timezone).local} to ${whenOut(end, ctx.timezone).local}.`,
      entityId: row.id,
      result: {
        timeBlockId: row.id,
        start: whenOut(start, ctx.timezone),
        end: whenOut(end, ctx.timezone),
      },
    };
  },
});

/* ------------------------------- update_service ----------------------------- */

const updateServiceSchema = z
  .object({
    serviceId: idSchema,
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    priceCents: z.number().int().min(0).max(1_000_000).optional(),
    durationMin: z.number().int().min(5).max(600).optional(),
    bufferMin: z.number().int().min(0).max(240).optional(),
    depositPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .optional()
      .describe("null = use the business default."),
    active: z.boolean().optional().describe("false hides the service from online booking."),
  })
  .refine(
    (a) => Object.keys(a).some((k) => k !== "serviceId" && a[k as keyof typeof a] !== undefined),
    {
      message: "Change at least one field.",
    },
  );

const SERVICE_FIELDS = [
  "name",
  "description",
  "priceCents",
  "durationMin",
  "bufferMin",
  "depositPct",
  "active",
] as const;

function serviceChanges(
  current: typeof service.$inferSelect,
  args: z.infer<typeof updateServiceSchema>,
) {
  return SERVICE_FIELDS.flatMap((field) => {
    const next = args[field];
    return next !== undefined && next !== current[field]
      ? [{ field, from: current[field], to: next }]
      : [];
  });
}

export const updateServiceTool = defineWrite({
  kind: "write",
  name: "update_service",
  title: "Update service",
  description:
    "Change a service's name, description, price, duration, buffer, deposit override or whether it is bookable. " +
    "Existing bookings keep the price and duration they were made with. Previews the exact before and after.",
  schema: updateServiceSchema,
  destructive: false,
  entityType: "service",
  auditArgs: (a) => ({ ...a }),
  async prepare(args, ctx) {
    const [current] = await ctx.deps.db
      .select()
      .from(service)
      .where(eq(service.id, args.serviceId));
    if (!current) throw new McpToolError("not_found", "No service with that id.");
    const changes = serviceChanges(current, args);
    if (changes.length === 0)
      throw new McpToolError("invalid_input", "That would not change anything.");
    const show = (f: string, v: unknown) =>
      f === "priceCents" && typeof v === "number" ? dollars(v) : JSON.stringify(v);
    return {
      summary:
        `Update service ${quoted(current.name)}: ` +
        changes
          .map((c) => `${c.field} ${show(c.field, c.from)} -> ${show(c.field, c.to)}`)
          .join("; ") +
        ". Existing bookings are unaffected.",
      details: { serviceId: current.id, changes },
    };
  },
  async execute(args, ctx) {
    const [current] = await ctx.deps.db
      .select()
      .from(service)
      .where(eq(service.id, args.serviceId));
    if (!current) throw new McpToolError("not_found", "No service with that id.");
    const changes = serviceChanges(current, args);
    if (changes.length === 0)
      throw new McpToolError("invalid_input", "That would not change anything.");
    const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
    await ctx.deps.db.update(service).set(patch).where(eq(service.id, current.id));
    return {
      summary: `Updated ${changes.length} field(s) on the service.`,
      entityId: current.id,
      result: { serviceId: current.id, changes },
    };
  },
});

/* ------------------------------ add_client_note ----------------------------- */

const noteSchema = z.object({
  clientId: idSchema,
  note: z.string().trim().min(1).max(1000),
});

export const addClientNoteTool = defineWrite({
  kind: "write",
  name: "add_client_note",
  title: "Add client note",
  description:
    "Append a dated note to a client's record (cut formula, preferences, anything worth remembering). Existing notes are kept.",
  schema: noteSchema,
  destructive: false,
  entityType: "client",
  auditArgs: (a) => ({ noteLength: a.note.length }),
  async prepare(args, ctx) {
    const c = await loadClient(ctx.deps.db, args.clientId);
    if (c.mergedIntoId) {
      throw new McpToolError(
        "precondition_failed",
        "That client was merged into another record. Use the merged client's id.",
      );
    }
    const name = personName(c.firstName, c.lastName);
    return {
      summary: `Add this note to ${quoted(name)}'s record: ${quoted(args.note, 300)}`,
      details: {
        client: { id: c.id, name: untrusted(name, 120) },
        note: untrusted(args.note, 1000),
        existingNotesLength: c.notes?.length ?? 0,
      },
    };
  },
  async execute(args, ctx) {
    const c = await loadClient(ctx.deps.db, args.clientId);
    const stamp = whenOut(ctx.deps.now(), ctx.timezone).local;
    const line = `[${stamp} via Claude] ${args.note}`;
    const notes = c.notes ? `${c.notes}\n${line}` : line;
    await ctx.deps.db.update(client).set({ notes }).where(eq(client.id, c.id));
    return {
      summary: "Note added.",
      entityId: c.id,
      result: { clientId: c.id, notesLength: notes.length },
    };
  },
});

/* -------------------------------- send_message ------------------------------ */

const messageSchema = z
  .object({
    clientId: idSchema,
    channel: z.enum(["email", "sms"]),
    subject: z.string().trim().max(150).optional().describe("Email only."),
    body: z.string().trim().min(1).max(1000),
  })
  .refine((a) => a.channel !== "sms" || a.body.length <= 480, {
    message: "SMS bodies are limited to 480 characters.",
    path: ["body"],
  })
  .refine((a) => a.channel === "email" || a.subject === undefined, {
    message: "subject is only for email.",
    path: ["subject"],
  });

export const sendMessageTool = defineWrite({
  kind: "write",
  name: "send_message",
  title: "Send message to a client",
  description:
    "Send a one-off email or SMS to a client. Previews the exact recipient and wording first; nothing is sent until " +
    "the owner confirms. For transactional messages (changes, reminders). Marketing needs the client's consent.",
  schema: messageSchema,
  destructive: false,
  entityType: "client",
  auditArgs: (a) => ({
    channel: a.channel,
    bodyLength: a.body.length,
    hasSubject: Boolean(a.subject),
  }),
  async prepare(args, ctx) {
    const c = await loadClient(ctx.deps.db, args.clientId);
    if (c.mergedIntoId) {
      throw new McpToolError(
        "precondition_failed",
        "That client was merged into another record. Use the merged client's id.",
      );
    }
    const address = args.channel === "email" ? c.email : c.phone;
    if (!address) {
      throw new McpToolError(
        "precondition_failed",
        `That client has no ${args.channel === "email" ? "email address" : "mobile number"} on file.`,
      );
    }
    const name = personName(c.firstName, c.lastName);
    return {
      summary:
        `Send an ${args.channel.toUpperCase()} to ${quoted(name)} at ${quoted(address, 120)}` +
        `${args.subject ? ` with subject ${quoted(args.subject, 150)}` : ""}: ${quoted(args.body, 600)}`,
      details: {
        client: { id: c.id, name: untrusted(name, 120) },
        channel: args.channel,
        to: untrusted(address, 200),
        subject: untrusted(args.subject ?? null, 150),
        body: untrusted(args.body, 1000),
        clientHasMarketingConsent: c.marketingOptIn,
      },
    };
  },
  async execute(args, ctx) {
    await callBackend(() =>
      ctx.deps.services.sendOneOffMessage(ctx.deps.db, {
        clientId: args.clientId,
        channel: args.channel,
        subject: args.subject,
        body: args.body,
      }),
    );
    return {
      summary: `Sent the ${args.channel}.`,
      entityId: args.clientId,
      result: { clientId: args.clientId, channel: args.channel, sent: true },
    };
  },
});
