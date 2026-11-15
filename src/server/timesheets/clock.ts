import { and, asc, eq, isNull } from "drizzle-orm";
import { location, staff, timeEntry } from "@/db/schema";
import { recordAudit, type Actor } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { Db } from "../db-types";
import { TimesheetError } from "./errors";

export type TimeEntryRow = typeof timeEntry.$inferSelect;

const MAX_BREAK_MINUTES = 600;
const POSTGRES_UNIQUE_VIOLATION = "23505";

/** True when the error (or anything it wraps) is a unique violation, i.e. the one-open-entry rule. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface ClockInInput {
  staffId: string;
  locationId?: string | null;
  actor: Actor;
}

export interface ClockOutInput {
  staffId: string;
  breakMinutes?: number;
  actor: Actor;
}

const alreadyClockedIn = () =>
  new TimesheetError("already_clocked_in", "You are already clocked in. Clock out first.");

/** The person's open entry (clocked in, not yet out), if any. */
export async function getOpenEntry(db: Db, staffId: string): Promise<TimeEntryRow | null> {
  const [row] = await db
    .select()
    .from(timeEntry)
    .where(and(eq(timeEntry.staffId, staffId), isNull(timeEntry.clockOut)))
    .limit(1);
  return row ?? null;
}

/**
 * Start a shift. One open entry per person is enforced by the database (a unique partial index); the check
 * here gives a friendly message and the constraint still catches two taps racing each other.
 */
export async function clockIn(
  db: Db,
  input: ClockInInput,
  clock: Clock = systemClock,
): Promise<TimeEntryRow> {
  const now = clock();
  const [person] = await db
    .select({ id: staff.id, active: staff.active })
    .from(staff)
    .where(eq(staff.id, input.staffId))
    .limit(1);
  if (!person || !person.active) {
    throw new TimesheetError("unknown_staff", "That team member is not active.");
  }
  if (input.locationId) {
    const [loc] = await db
      .select({ id: location.id, active: location.active })
      .from(location)
      .where(eq(location.id, input.locationId))
      .limit(1);
    if (!loc || !loc.active) {
      throw new TimesheetError("unknown_location", "Pick one of the active locations.", {
        locationId: "Pick one of the active locations.",
      });
    }
  }
  if (await getOpenEntry(db, input.staffId)) throw alreadyClockedIn();

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(timeEntry)
        .values({
          staffId: input.staffId,
          locationId: input.locationId ?? null,
          clockIn: now,
          source: "clock",
        })
        .returning();
      await recordAudit(tx, {
        actor: input.actor,
        action: "timesheet.clock_in",
        entityType: "time_entry",
        entityId: row.id,
        data: { staffId: input.staffId, locationId: input.locationId ?? null },
      });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw alreadyClockedIn();
    throw error;
  }
}

/** End the open shift. Rejected when nobody is clocked in or when the time would not be after clock-in. */
export async function clockOut(
  db: Db,
  input: ClockOutInput,
  clock: Clock = systemClock,
): Promise<TimeEntryRow> {
  const now = clock();
  const breakMinutes = input.breakMinutes ?? 0;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > MAX_BREAK_MINUTES) {
    throw new TimesheetError("bad_break", "Break minutes must be a whole number from 0 to 600.", {
      breakMinutes: "Enter whole minutes from 0 to 600.",
    });
  }

  return db.transaction(async (tx) => {
    const open = await getOpenEntry(tx, input.staffId);
    if (!open) throw new TimesheetError("not_clocked_in", "You are not clocked in.");
    if (now.getTime() <= open.clockIn.getTime()) {
      throw new TimesheetError("clock_out_before_in", "Clock-out must be after clock-in.");
    }
    const elapsedMinutes = Math.round((now.getTime() - open.clockIn.getTime()) / 60_000);
    if (breakMinutes > elapsedMinutes) {
      throw new TimesheetError("bad_break", "The break is longer than the shift.", {
        breakMinutes: "The break is longer than the shift.",
      });
    }
    const [row] = await tx
      .update(timeEntry)
      .set({ clockOut: now, breakMinutes })
      .where(and(eq(timeEntry.id, open.id), isNull(timeEntry.clockOut)))
      .returning();
    if (!row) throw new TimesheetError("not_clocked_in", "You are not clocked in.");
    await recordAudit(tx, {
      actor: input.actor,
      action: "timesheet.clock_out",
      entityType: "time_entry",
      entityId: row.id,
      data: { staffId: input.staffId, breakMinutes },
    });
    return row;
  });
}

export interface ClockState {
  open: {
    entryId: string;
    clockIn: Date;
    locationId: string | null;
    locationName: string | null;
  } | null;
  /** Active locations to choose from when clocking in. */
  locations: Array<{ id: string; name: string }>;
}

/** What the Clock widget needs: the open shift (if any) and the places someone can clock in at. */
export async function getClockState(db: Db, staffId: string): Promise<ClockState> {
  const [open, locations] = await Promise.all([
    getOpenEntry(db, staffId),
    db
      .select({ id: location.id, name: location.name })
      .from(location)
      .where(eq(location.active, true))
      .orderBy(asc(location.sortOrder), asc(location.name)),
  ]);
  const named = open?.locationId ? locations.find((l) => l.id === open.locationId) : undefined;
  return {
    open: open
      ? {
          entryId: open.id,
          clockIn: open.clockIn,
          locationId: open.locationId,
          locationName: named?.name ?? null,
        }
      : null,
    locations,
  };
}
