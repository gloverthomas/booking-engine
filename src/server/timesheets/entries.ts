import { and, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { location, staff, timeEntry } from "@/db/schema";
import { recordAudit, type Actor } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { Db } from "../db-types";
import type { TimeEntryRow } from "./clock";
import { TimesheetError } from "./errors";

const MAX_SHIFT_MS = 24 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 60_000;
const MAX_BREAK_MINUTES = 600;

export interface ManualEntryInput {
  staffId: string;
  clockIn: Date;
  clockOut: Date;
  breakMinutes?: number;
  locationId?: string | null;
  note?: string | null;
  /** Why this entry is being added by hand. Kept in the audit log. */
  reason: string;
  actor: Actor;
}

export interface EditEntryInput {
  entryId: string;
  clockIn?: Date;
  /** Leave out to keep it. An entry cannot be reopened once it has a clock-out. */
  clockOut?: Date;
  breakMinutes?: number;
  locationId?: string | null;
  note?: string | null;
  /** Why the entry is being changed. Required: every edit is audited with it. */
  reason: string;
  actor: Actor;
}

interface Shape {
  staffId: string;
  clockIn: Date;
  clockOut: Date | null;
  breakMinutes: number;
}

function fail(code: string, message: string, field?: string): never {
  throw new TimesheetError(code, message, field ? { [field]: message } : {});
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3) fail("reason_required", "Say why you are changing this entry.", "reason");
  return trimmed;
}

function validateShape(shape: Shape, now: Date): void {
  const { clockIn, clockOut, breakMinutes } = shape;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > MAX_BREAK_MINUTES) {
    fail("bad_break", "Enter whole break minutes from 0 to 600.", "breakMinutes");
  }
  if (clockIn.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    fail("in_future", "The start time cannot be in the future.", "clockIn");
  }
  if (!clockOut) return;
  if (clockOut.getTime() <= clockIn.getTime()) {
    fail("clock_out_before_in", "The end time must be after the start time.", "clockOut");
  }
  if (clockOut.getTime() - clockIn.getTime() > MAX_SHIFT_MS) {
    fail("too_long", "A single entry cannot be longer than 24 hours.", "clockOut");
  }
  if (clockOut.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    fail("in_future", "The end time cannot be in the future.", "clockOut");
  }
  if (breakMinutes > Math.round((clockOut.getTime() - clockIn.getTime()) / 60_000)) {
    fail("bad_break", "The break is longer than the shift.", "breakMinutes");
  }
}

/** Entries overlap when each starts before the other ends. An open entry runs until further notice. */
async function assertNoOverlap(db: Db, shape: Shape, excludeEntryId: string | null): Promise<void> {
  const clash = and(
    eq(timeEntry.staffId, shape.staffId),
    excludeEntryId ? ne(timeEntry.id, excludeEntryId) : undefined,
    or(isNull(timeEntry.clockOut), gt(timeEntry.clockOut, shape.clockIn)),
    shape.clockOut ? lt(timeEntry.clockIn, shape.clockOut) : undefined,
  );
  const [existing] = await db.select({ id: timeEntry.id }).from(timeEntry).where(clash).limit(1);
  if (existing) {
    fail("overlap", "That overlaps another time entry for this person.", "clockIn");
  }
}

async function assertLocation(db: Db, locationId: string | null | undefined): Promise<void> {
  if (!locationId) return;
  const [row] = await db
    .select({ id: location.id })
    .from(location)
    .where(eq(location.id, locationId))
    .limit(1);
  if (!row) fail("unknown_location", "That location does not exist.", "locationId");
}

const snapshot = (row: TimeEntryRow) => ({
  clockIn: row.clockIn.toISOString(),
  clockOut: row.clockOut?.toISOString() ?? null,
  breakMinutes: row.breakMinutes,
  locationId: row.locationId,
  note: row.note,
  approved: row.approvedAt !== null,
});

/** Add a finished shift by hand (a forgotten clock-in, or someone without a phone to hand). */
export async function createManualEntry(
  db: Db,
  input: ManualEntryInput,
  clock: Clock = systemClock,
): Promise<TimeEntryRow> {
  const reason = requireReason(input.reason);
  const shape: Shape = {
    staffId: input.staffId,
    clockIn: input.clockIn,
    clockOut: input.clockOut,
    breakMinutes: input.breakMinutes ?? 0,
  };
  validateShape(shape, clock());

  return db.transaction(async (tx) => {
    const [person] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.id, input.staffId))
      .limit(1);
    if (!person) fail("unknown_staff", "That team member does not exist.", "staffId");
    await assertLocation(tx, input.locationId);
    await assertNoOverlap(tx, shape, null);
    const [row] = await tx
      .insert(timeEntry)
      .values({
        staffId: input.staffId,
        locationId: input.locationId ?? null,
        clockIn: input.clockIn,
        clockOut: input.clockOut,
        breakMinutes: shape.breakMinutes,
        source: "manual",
        note: input.note?.trim() || null,
      })
      .returning();
    await recordAudit(tx, {
      actor: input.actor,
      action: "timesheet.manual_entry",
      entityType: "time_entry",
      entityId: row.id,
      data: { staffId: input.staffId, reason, after: snapshot(row) },
    });
    return row;
  });
}

/** Change an entry. Always needs a reason, is audited with before and after, and clears any approval. */
export async function editEntry(
  db: Db,
  input: EditEntryInput,
  clock: Clock = systemClock,
): Promise<TimeEntryRow> {
  const reason = requireReason(input.reason);
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(timeEntry)
      .where(eq(timeEntry.id, input.entryId))
      .limit(1);
    if (!before) fail("not_found", "That time entry no longer exists.");
    const next: Shape = {
      staffId: before.staffId,
      clockIn: input.clockIn ?? before.clockIn,
      clockOut: input.clockOut ?? before.clockOut,
      breakMinutes: input.breakMinutes ?? before.breakMinutes,
    };
    validateShape(next, clock());
    if (input.locationId !== undefined) await assertLocation(tx, input.locationId);
    await assertNoOverlap(tx, next, before.id);
    const [after] = await tx
      .update(timeEntry)
      .set({
        clockIn: next.clockIn,
        clockOut: next.clockOut,
        breakMinutes: next.breakMinutes,
        locationId: input.locationId === undefined ? before.locationId : input.locationId,
        note: input.note === undefined ? before.note : input.note?.trim() || null,
        approvedAt: null,
        approvedBy: null,
      })
      .where(eq(timeEntry.id, before.id))
      .returning();
    await recordAudit(tx, {
      actor: input.actor,
      action: "timesheet.entry_edited",
      entityType: "time_entry",
      entityId: before.id,
      data: { staffId: before.staffId, reason, before: snapshot(before), after: snapshot(after) },
    });
    return after;
  });
}

export interface ApproveInput {
  entryIds: readonly string[];
  actor: Actor;
  /** The approver's own staff row, so a manager cannot approve their own hours. */
  approverStaffId?: string | null;
}

export interface ApproveResult {
  approved: number;
  /** Still clocked in: nothing to approve yet. */
  skippedOpen: number;
  /** The approver's own hours (owners may approve their own). */
  skippedOwn: number;
  alreadyApproved: number;
}

/** Approve finished entries. Idempotent; open entries and a non-owner's own entries are skipped, not errors. */
export async function approveEntries(
  db: Db,
  input: ApproveInput,
  clock: Clock = systemClock,
): Promise<ApproveResult> {
  const ids = [...new Set(input.entryIds)];
  const result: ApproveResult = { approved: 0, skippedOpen: 0, skippedOwn: 0, alreadyApproved: 0 };
  if (ids.length === 0) return result;
  const now = clock();
  const isOwner = input.actor.startsWith("owner:");

  return db.transaction(async (tx) => {
    const rows = await tx.select().from(timeEntry).where(inArray(timeEntry.id, ids));
    if (rows.length !== ids.length)
      fail("not_found", "One of those time entries no longer exists.");
    const outcome = { ...result };
    for (const row of rows) {
      if (row.clockOut === null) {
        outcome.skippedOpen += 1;
        continue;
      }
      if (!isOwner && input.approverStaffId && row.staffId === input.approverStaffId) {
        outcome.skippedOwn += 1;
        continue;
      }
      if (row.approvedAt) {
        outcome.alreadyApproved += 1;
        continue;
      }
      await tx
        .update(timeEntry)
        .set({ approvedAt: now, approvedBy: input.actor })
        .where(eq(timeEntry.id, row.id));
      await recordAudit(tx, {
        actor: input.actor,
        action: "timesheet.entry_approved",
        entityType: "time_entry",
        entityId: row.id,
        data: { staffId: row.staffId },
      });
      outcome.approved += 1;
    }
    return outcome;
  });
}
