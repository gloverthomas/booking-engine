import type { Actor } from "../audit";
import type { Clock } from "../clock";
import type { Db } from "../db-types";
import { clockIn, clockOut } from "./clock";
import { approveEntries, createManualEntry, editEntry, type ApproveResult } from "./entries";
import { TimesheetError } from "./errors";
import type { EditEntryForm, ManualEntryForm } from "./schemas";
import { parseLocalDateTime } from "./time";

export interface CommandContext {
  db: Db;
  actor: Actor;
  /** The signed-in person's staff row. Null for an owner who has none. */
  staffId: string | null;
  timezone: string;
  clock?: Clock;
}

const NEEDS_STAFF = new TimesheetError(
  "no_staff_profile",
  "Your login is not linked to a staff profile yet, so there is no timesheet to clock into.",
);

/** Clock the signed-in person in. Always for themselves: there is no staffId input to tamper with. */
export async function clockInCommand(
  ctx: CommandContext,
  input: { locationId?: string | null },
): Promise<{ entryId: string }> {
  if (!ctx.staffId) throw NEEDS_STAFF;
  const row = await clockIn(
    ctx.db,
    { staffId: ctx.staffId, locationId: input.locationId ?? null, actor: ctx.actor },
    ctx.clock,
  );
  return { entryId: row.id };
}

export async function clockOutCommand(
  ctx: CommandContext,
  input: { breakMinutes: number },
): Promise<{ entryId: string }> {
  if (!ctx.staffId) throw NEEDS_STAFF;
  const row = await clockOut(
    ctx.db,
    { staffId: ctx.staffId, breakMinutes: input.breakMinutes, actor: ctx.actor },
    ctx.clock,
  );
  return { entryId: row.id };
}

export async function addManualEntryCommand(
  ctx: CommandContext,
  input: ManualEntryForm,
): Promise<{ entryId: string }> {
  const row = await createManualEntry(
    ctx.db,
    {
      staffId: input.staffId,
      clockIn: parseLocalDateTime(input.clockIn, ctx.timezone),
      clockOut: parseLocalDateTime(input.clockOut, ctx.timezone),
      breakMinutes: input.breakMinutes,
      locationId: input.locationId ?? null,
      note: input.note ?? null,
      reason: input.reason,
      actor: ctx.actor,
    },
    ctx.clock,
  );
  return { entryId: row.id };
}

export async function editEntryCommand(
  ctx: CommandContext,
  input: EditEntryForm,
): Promise<{ entryId: string }> {
  const row = await editEntry(
    ctx.db,
    {
      entryId: input.entryId,
      clockIn: input.clockIn ? parseLocalDateTime(input.clockIn, ctx.timezone) : undefined,
      clockOut: input.clockOut ? parseLocalDateTime(input.clockOut, ctx.timezone) : undefined,
      breakMinutes: input.breakMinutes,
      locationId: input.locationId,
      note: input.note,
      reason: input.reason,
      actor: ctx.actor,
    },
    ctx.clock,
  );
  return { entryId: row.id };
}

export async function approveEntriesCommand(
  ctx: CommandContext,
  input: { entryIds: string[] },
): Promise<ApproveResult> {
  return approveEntries(
    ctx.db,
    { entryIds: input.entryIds, actor: ctx.actor, approverStaffId: ctx.staffId },
    ctx.clock,
  );
}
