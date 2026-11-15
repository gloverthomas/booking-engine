import { z } from "zod";
import { TARGET_METRICS } from "./units";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-16");

/** What the target form posts. The value is human text ("4,000", "62.5"); the command converts it. */
export const targetFormSchema = z.object({
  /** Empty or missing = business-wide. */
  staffId: z
    .string()
    .uuid()
    .nullish()
    .or(z.literal("").transform(() => null)),
  metric: z.enum(TARGET_METRICS),
  period: z.enum(["week", "month"]),
  targetValue: z.string().trim().min(1, "Enter a target").max(20),
  validFrom: localDate,
  validTo: localDate.nullish().or(z.literal("").transform(() => null)),
});

export const updateTargetSchema = targetFormSchema.extend({ id: z.string().uuid() });
export const deleteTargetSchema = z.object({ id: z.string().uuid() });

export type TargetForm = z.infer<typeof targetFormSchema>;

/** Query string for the performance page. */
export const performanceQuerySchema = z.object({
  period: z.enum(["week", "month"]).default("week"),
  date: localDate.optional(),
});
