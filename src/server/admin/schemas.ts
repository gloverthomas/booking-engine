import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";

/** Input validation for every admin server action. Dates arrive as ISO strings and leave as Date. */

const id = z.uuid();
const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const trimmed = (max: number) => z.string().trim().max(max);

const phone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const parsed = parsePhoneNumberFromString(value, "AU");
    if (!parsed?.isValid()) {
      ctx.addIssue({ code: "custom", message: "Enter a valid phone number" });
      return z.NEVER;
    }
    return parsed.number;
  });

const newClient = z.object({
  firstName: trimmed(80).min(1, "First name is required"),
  lastName: trimmed(80),
  phone,
  email: z.union([z.literal(""), z.string().trim().pipe(z.email("Enter a valid email"))]),
});

export const createBookingSchema = z.object({
  locationId: id,
  staffId: id.optional(),
  serviceIds: z.array(id).min(1, "Choose at least one service").max(10),
  start: isoDate,
  client: z.union([z.object({ existingClientId: id }), z.object({ newClient })]),
  comments: trimmed(1000).optional(),
  notifyClient: z.boolean(),
});

export const rescheduleSchema = z.object({
  bookingId: id,
  newStart: isoDate,
  notifyClient: z.boolean(),
});

export const cancelSchema = z.object({
  bookingId: id,
  depositMode: z.enum(["refund", "keep"]),
  reason: trimmed(500).optional(),
});

export const reassignSchema = z.object({
  bookingId: id,
  newStaffId: id,
  notifyClient: z.boolean(),
});

export const bookingIdSchema = z.object({ bookingId: id });

export const refundSchema = z.object({
  bookingId: id,
  paymentId: id,
  amountCents: z.number().int().positive().optional(),
});

export const blockSchema = z
  .object({
    staffId: id,
    start: isoDate,
    end: isoDate,
    reason: trimmed(200).optional(),
  })
  .refine((v) => v.end.getTime() > v.start.getTime(), {
    message: "The block must end after the start",
    path: ["end"],
  });

export const deleteBlockSchema = z.object({ blockId: id });

export const checkoutSchema = z.object({
  bookingId: id,
  method: z.enum(["cash", "eftpos", "other"]),
});

export const notesSchema = z.object({ clientId: id, notes: z.string().max(4000) });
export const blockedSchema = z.object({ clientId: id, blocked: z.boolean() });
export const vipSchema = z.object({ clientId: id, isVip: z.boolean() });
export const mergeSchema = z.object({ keepClientId: id, duplicateClientId: id });

/* Read endpoints (query strings) ------------------------------------------ */

const MAX_CALENDAR_SPAN_MS = 62 * 24 * 60 * 60 * 1000;

export const calendarQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    locationId: id.optional(),
    /** Comma-separated stylist ids to show. Absent means everyone the viewer may see. */
    staffIds: z
      .string()
      .transform((value) => value.split(",").filter((part) => part !== ""))
      .pipe(z.array(id).max(50))
      .optional(),
  })
  .refine((v) => v.to.getTime() > v.from.getTime(), { message: "Invalid date range" })
  .refine((v) => v.to.getTime() - v.from.getTime() <= MAX_CALENDAR_SPAN_MS, {
    message: "Date range is too large",
  });

export const clientSearchQuerySchema = z.object({ q: z.string().trim().max(100).default("") });

/** URLSearchParams -> plain object, dropping empty values so optional fields stay optional. */
export function queryToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (value !== "") out[key] = value;
  }
  return out;
}
