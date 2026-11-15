import { DateTime } from "luxon";
import { z } from "zod";

/** A real calendar date, YYYY-MM-DD. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD")
  .refine((value) => DateTime.fromISO(value).isValid, "That is not a real date");

export const minuteRangeSchema = z.object({
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
});

export const weeklyHoursSchema = z.object({
  staffId: z.uuid(),
  locationId: z.uuid(),
  /** Seven days, index 0 = Sunday. */
  week: z.array(z.array(minuteRangeSchema).max(8)).length(7),
});

const noteSchema = z
  .string()
  .trim()
  .max(200, "Keep the note under 200 characters")
  .nullish()
  .transform((value) => (value ? value : null));

export const dayOffSchema = z.object({
  staffId: z.uuid(),
  date: isoDateSchema,
  /** Null = the day off applies at every location. */
  locationId: z.uuid().nullable(),
  note: noteSchema,
});

export const customHoursSchema = z.object({
  staffId: z.uuid(),
  date: isoDateSchema,
  locationId: z.uuid(),
  ranges: z.array(minuteRangeSchema).min(1, "Add at least one range").max(4),
  note: noteSchema,
});

export const removeExceptionSchema = z.object({ id: z.uuid() });

export const timeBlockSchema = z.object({
  staffId: z.uuid(),
  start: z.string().min(1, "Choose a start"),
  end: z.string().min(1, "Choose an end"),
  reason: z.string().trim().max(200).nullish(),
});

export const idSchema = z.object({ id: z.uuid() });

export type DayOffInput = z.output<typeof dayOffSchema>;
export type CustomHoursInput = z.output<typeof customHoursSchema>;
