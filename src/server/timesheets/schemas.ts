import { z } from "zod";

const uuid = z.string().uuid();
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use a date and time like 2026-11-16 09:00");
const breakMinutes = z.coerce
  .number()
  .int("Whole minutes only")
  .min(0, "Cannot be negative")
  .max(600, "At most 600 minutes");
const note = z.string().trim().max(500, "At most 500 characters");
const reason = z.string().trim().min(3, "Say why you are changing this").max(300);

export const clockInSchema = z.object({ locationId: uuid.nullish() });
export const clockOutSchema = z.object({ breakMinutes: breakMinutes.default(0) });

/** Times are business-local wall-clock values from a datetime-local input; the server converts them. */
export const manualEntrySchema = z.object({
  staffId: uuid,
  clockIn: localDateTime,
  clockOut: localDateTime,
  breakMinutes: breakMinutes.default(0),
  locationId: uuid.nullish(),
  note: note.nullish(),
  reason,
});

export const editEntrySchema = z.object({
  entryId: uuid,
  clockIn: localDateTime.optional(),
  clockOut: localDateTime.optional(),
  breakMinutes: breakMinutes.optional(),
  locationId: uuid.nullish(),
  note: note.nullish(),
  reason,
});

export const approveEntriesSchema = z.object({
  entryIds: z.array(uuid).min(1, "Pick at least one entry").max(200),
});

/** Query string for the timesheets page and its CSV export. */
export const timesheetQuerySchema = z.object({
  week: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  staff: uuid.optional(),
  kind: z.enum(["summary", "entries"]).default("summary"),
});

export type ManualEntryForm = z.infer<typeof manualEntrySchema>;
export type EditEntryForm = z.infer<typeof editEntrySchema>;
