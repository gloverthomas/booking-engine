import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { daysBetween, isValidDateString } from "./public-api-time";

/** Longest date range the availability endpoint will serve in one request. */
export const MAX_AVAILABILITY_SPAN_DAYS = 62;
export const MAX_SERVICES_PER_BOOKING = 10;
export const DEFAULT_PHONE_REGION = "AU";

const id = z.guid("Invalid identifier");

const trimmed = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);

const required = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `Keep this under ${max} characters`);

/** Normalises any plausible Australian (or international) number to E.164. */
export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Mobile number is required")
  .max(40, "Enter a valid mobile number")
  .transform((value, ctx) => {
    const parsed = parsePhoneNumberFromString(value, DEFAULT_PHONE_REGION);
    if (!parsed?.isValid()) {
      ctx.issues.push({ code: "custom", message: "Enter a valid mobile number", input: value });
      return z.NEVER;
    }
    return parsed.number;
  });

const optionalPhone = z
  .string()
  .trim()
  .max(40)
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    const parsed = parsePhoneNumberFromString(value, DEFAULT_PHONE_REGION);
    if (!parsed?.isValid()) {
      ctx.issues.push({ code: "custom", message: "Enter a valid phone number", input: value });
      return z.NEVER;
    }
    return parsed.number;
  });

const emailSchema = z
  .string()
  .trim()
  .min(1, "Email is required")
  .pipe(z.email("Enter a valid email address"))
  .transform((value) => value.toLowerCase());

const localDate = z.string().refine(isValidDateString, "Use a date like 2026-11-20");

export const availabilityQuerySchema = z
  .object({
    locationId: id,
    serviceIds: z
      .string()
      .transform((value) => value.split(",").filter(Boolean))
      .pipe(z.array(id).min(1, "Choose at least one service").max(MAX_SERVICES_PER_BOOKING)),
    staffId: id.optional(),
    fromDate: localDate,
    toDate: localDate,
  })
  .superRefine((value, ctx) => {
    const span = daysBetween(value.fromDate, value.toDate);
    if (span < 0) {
      ctx.addIssue({ code: "custom", path: ["toDate"], message: "toDate is before fromDate" });
    } else if (span > MAX_AVAILABILITY_SPAN_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["toDate"],
        message: `Ask for at most ${MAX_AVAILABILITY_SPAN_DAYS} days at a time`,
      });
    }
  });

export type AvailabilityQueryInput = z.infer<typeof availabilityQuerySchema>;

export const holdBodySchema = z.object({
  locationId: id,
  serviceIds: z.array(id).min(1, "Choose at least one service").max(MAX_SERVICES_PER_BOOKING),
  staffId: id.optional(),
  /** True when the client picked this stylist; false when staffId only pins the quoted one for "anyone". */
  staffRequested: z.boolean().default(false),
  start: z.iso.datetime({ offset: true, message: "Choose a time" }),
  client: z.object({
    firstName: required("First name", 60),
    lastName: required("Last name", 60),
    email: emailSchema,
    phone: phoneSchema,
    pronouns: trimmed(40).optional(),
    marketingOptIn: z.boolean().default(false),
  }),
  otherPhone: optionalPhone,
  company: trimmed(100).optional(),
  bookedForOther: z.boolean().default(false),
  comments: trimmed(1000).optional(),
  intakeAnswers: z.record(z.string().max(64), trimmed(500)).default({}),
  policyVersion: z.string().min(1).max(64),
  policyAccepted: z.literal(true, "You need to agree to the cancellation policy"),
  turnstileToken: z.string().max(2048).optional(),
});

export type HoldBody = z.infer<typeof holdBodySchema>;

export const cancelBodySchema = z.object({
  reason: trimmed(300).optional(),
});

export const rescheduleBodySchema = z.object({
  start: z.iso.datetime({ offset: true, message: "Choose a time" }),
});

/** Flatten zod issues to `{ "client.email": "Enter a valid email address" }` (first message wins). */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    out[key] ??= issue.message;
  }
  return out;
}
