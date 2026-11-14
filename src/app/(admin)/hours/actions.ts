"use server";

import { z } from "zod";
import { createTimeBlock, deleteTimeBlock, saveWeeklyHours } from "@/server/admin-foundation/hours";
import { getBusiness } from "@/server/admin-foundation/business";
import { ownerAction } from "@/server/admin-foundation/owner-action";

const rangeSchema = z.object({
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
});

const weeklyHoursSchema = z.object({
  staffId: z.uuid(),
  locationId: z.uuid(),
  /** Seven days, index 0 = Sunday. */
  week: z.array(z.array(rangeSchema).max(8)).length(7),
});

export async function saveWeeklyHoursAction(input: unknown) {
  return ownerAction(weeklyHoursSchema, input, (parsed, { db, actor }) =>
    saveWeeklyHours(db, actor, parsed),
  );
}

const timeBlockSchema = z.object({
  staffId: z.uuid(),
  start: z.string().min(1, "Choose a start"),
  end: z.string().min(1, "Choose an end"),
  reason: z.string().trim().max(200).nullish(),
});

/** Returns how many existing bookings overlap the new block so the UI can warn (it never blocks). */
export async function createTimeBlockAction(input: unknown) {
  return ownerAction(timeBlockSchema, input, async (parsed, { db, actor }) => {
    const { timezone } = await getBusiness(db);
    return createTimeBlock(db, actor, parsed, timezone);
  });
}

export async function deleteTimeBlockAction(id: string) {
  return ownerAction(z.object({ id: z.uuid() }), { id }, async (parsed, { db, actor }) => {
    await deleteTimeBlock(db, actor, parsed.id);
  });
}
