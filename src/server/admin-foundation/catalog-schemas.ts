import { z } from "zod";
import { parseDollarsToCents } from "./money";

/** "95", "$95.50" -> cents. Used wherever the owner types a price. */
export const dollarsSchema = z.string().transform((value, ctx) => {
  const cents = parseDollarsToCents(value);
  if (cents === null) {
    ctx.issues.push({
      code: "custom",
      message: "Enter a dollar amount like 95 or 95.50",
      input: value,
    });
    return z.NEVER;
  }
  return cents;
});

/** Empty string or null means "no value" (inherit the default). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const optionalDollars = z
  .string()
  .nullish()
  .transform((value, ctx) => {
    if (value === null || value === undefined || value.trim() === "") return null;
    const cents = parseDollarsToCents(value);
    if (cents === null) {
      ctx.issues.push({
        code: "custom",
        message: "Enter a dollar amount like 95 or 95.50",
        input: value,
      });
      return z.NEVER;
    }
    return cents;
  });

export const intakeQuestionSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use lowercase letters, numbers, - or _"),
  label: z.string().trim().min(1, "Write the question").max(200),
  required: z.boolean(),
});

export const staffOfferingSchema = z
  .object({
    staffId: z.uuid(),
    /** Optional per-stylist price override, typed in dollars; validated output is cents. */
    price: optionalDollars,
    /** Optional per-stylist duration override. */
    durationMin: z.number().int().min(5).max(720).nullish().default(null),
  })
  .transform(({ price, ...rest }) => ({ ...rest, priceCents: price }));

export const serviceInputSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, "Name is required").max(120),
    description: optionalText(2000),
    category: optionalText(80),
    durationMin: z.number().int().min(5, "At least 5 minutes").max(720),
    price: dollarsSchema,
    bufferMin: z.number().int().min(0).max(240).default(0),
    /** Null = use the business default deposit percentage. */
    depositPct: z.number().int().min(0).max(100).nullish().default(null),
    vipOnly: z.boolean().default(false),
    intakeQuestions: z.array(intakeQuestionSchema).max(10).default([]),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10000).default(0),
    locationIds: z.array(z.uuid()).default([]),
    staff: z.array(staffOfferingSchema).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, question] of value.intakeQuestions.entries()) {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["intakeQuestions", index, "id"],
          message: "Question ids must be unique",
        });
      }
      seen.add(question.id);
    }
    const staffSeen = new Set<string>();
    for (const [index, offering] of value.staff.entries()) {
      if (staffSeen.has(offering.staffId)) {
        ctx.addIssue({
          code: "custom",
          path: ["staff", index, "staffId"],
          message: "Each stylist can only be listed once",
        });
      }
      staffSeen.add(offering.staffId);
    }
  })
  .transform(({ price, ...rest }) => ({ ...rest, priceCents: price }));

/** What the form sends. */
export type ServiceFormInput = z.input<typeof serviceInputSchema>;
/** What the domain function receives after validation. */
export type ServiceInput = z.output<typeof serviceInputSchema>;

export const locationInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name is required").max(120),
  addressLine: optionalText(200),
  suburb: optionalText(100),
  state: optionalText(40),
  postcode: optionalText(10),
  phone: optionalText(40),
  arrivalNote: optionalText(1000),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

export type LocationFormInput = z.input<typeof locationInputSchema>;
export type LocationInput = z.output<typeof locationInputSchema>;
