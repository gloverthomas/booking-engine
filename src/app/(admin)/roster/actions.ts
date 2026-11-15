"use server";

import { getBusiness } from "@/server/admin-foundation/business";
import {
  createTimeBlock,
  deleteTimeBlock,
  saveWeeklyHours,
} from "@/server/admin-foundation/hours";
import { rosterAction } from "@/server/roster/access-action";
import { removeException, setCustomHours, setDayOff } from "@/server/roster/exceptions";
import {
  customHoursSchema,
  dayOffSchema,
  idSchema,
  removeExceptionSchema,
  timeBlockSchema,
  weeklyHoursSchema,
} from "@/server/roster/schemas";

/* Every mutation needs roster.editAll, is zod-validated and writes an audit row. */

export async function saveWeeklyHoursAction(input: unknown) {
  return rosterAction("roster.editAll", weeklyHoursSchema, input, (parsed, { db, actor }) =>
    saveWeeklyHours(db, actor, parsed),
  );
}

export async function setDayOffAction(input: unknown) {
  return rosterAction("roster.editAll", dayOffSchema, input, (parsed, { db, actor }) =>
    setDayOff(db, actor, parsed),
  );
}

export async function setCustomHoursAction(input: unknown) {
  return rosterAction("roster.editAll", customHoursSchema, input, (parsed, { db, actor }) =>
    setCustomHours(db, actor, parsed),
  );
}

export async function removeExceptionAction(input: unknown) {
  return rosterAction("roster.editAll", removeExceptionSchema, input, (parsed, { db, actor }) =>
    removeException(db, actor, parsed.id),
  );
}

/** Returns how many existing bookings overlap the new block so the UI can warn (it never blocks). */
export async function createTimeBlockAction(input: unknown) {
  return rosterAction("roster.editAll", timeBlockSchema, input, async (parsed, { db, actor }) => {
    const { timezone } = await getBusiness(db);
    return createTimeBlock(db, actor, parsed, timezone);
  });
}

export async function deleteTimeBlockAction(id: string) {
  return rosterAction("roster.editAll", idSchema, { id }, async (parsed, { db, actor }) => {
    await deleteTimeBlock(db, actor, parsed.id);
  });
}
