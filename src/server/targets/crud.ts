import { asc, eq } from "drizzle-orm";
import { staff, staffTarget } from "@/db/schema";
import { recordAudit, type Actor } from "../audit";
import type { Db } from "../db-types";
import { TargetError } from "./errors";
import type { TargetPeriod } from "./progress";
import { MAX_STORED, type TargetMetric } from "./units";

export interface TargetInput {
  /** Null = the whole business. */
  staffId: string | null;
  metric: TargetMetric;
  period: TargetPeriod;
  /** Stored unit: cents, a count, or basis points (see units.ts). */
  targetValue: number;
  /** Local dates, YYYY-MM-DD. */
  validFrom: string;
  validTo: string | null;
}

export interface TargetRow extends TargetInput {
  id: string;
  staffName: string | null;
}

const fail = (code: string, message: string, field?: string): never => {
  throw new TargetError(code, message, field ? { [field]: message } : {});
};

/** Every target, business-wide ones first, then by person. */
export async function listTargets(db: Db): Promise<TargetRow[]> {
  const rows = await db
    .select({
      id: staffTarget.id,
      staffId: staffTarget.staffId,
      staffName: staff.name,
      metric: staffTarget.metric,
      period: staffTarget.period,
      targetValue: staffTarget.targetValue,
      validFrom: staffTarget.validFrom,
      validTo: staffTarget.validTo,
    })
    .from(staffTarget)
    .leftJoin(staff, eq(staff.id, staffTarget.staffId))
    .orderBy(asc(staff.name), asc(staffTarget.metric), asc(staffTarget.validFrom));
  return rows.sort((a, b) => Number(a.staffId !== null) - Number(b.staffId !== null));
}

function validate(input: TargetInput): void {
  if (!Number.isInteger(input.targetValue) || input.targetValue <= 0) {
    fail("bad_target_value", "The target must be more than zero.", "targetValue");
  }
  if (input.targetValue > MAX_STORED[input.metric]) {
    fail("bad_target_value", "That target is too large.", "targetValue");
  }
  if (input.validTo !== null && input.validTo < input.validFrom) {
    fail("bad_range", "The end date cannot be before the start date.", "validTo");
  }
}

/** One target per person, metric and period type at a time: reject validity ranges that overlap. */
async function assertNoOverlap(db: Db, input: TargetInput, excludeId: string | null) {
  const existing = await listTargets(db);
  const clash = existing.find(
    (t) =>
      t.id !== excludeId &&
      t.staffId === input.staffId &&
      t.metric === input.metric &&
      t.period === input.period &&
      t.validFrom <= (input.validTo ?? "9999-12-31") &&
      input.validFrom <= (t.validTo ?? "9999-12-31"),
  );
  if (clash) {
    fail(
      "overlap",
      "There is already a target for that person, measure and period covering some of those dates. Change its end date first.",
      "validFrom",
    );
  }
}

async function assertStaff(db: Db, staffId: string | null) {
  if (staffId === null) return;
  const [row] = await db.select({ id: staff.id }).from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!row) fail("unknown_staff", "That team member does not exist.", "staffId");
}

export async function createTarget(db: Db, input: TargetInput, actor: Actor): Promise<string> {
  validate(input);
  return db.transaction(async (tx) => {
    await assertStaff(tx, input.staffId);
    await assertNoOverlap(tx, input, null);
    const [row] = await tx.insert(staffTarget).values(input).returning({ id: staffTarget.id });
    await recordAudit(tx, {
      actor,
      action: "target.created",
      entityType: "staff_target",
      entityId: row.id,
      data: { ...input },
    });
    return row.id;
  });
}

export async function updateTarget(
  db: Db,
  id: string,
  input: TargetInput,
  actor: Actor,
): Promise<void> {
  validate(input);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(staffTarget).where(eq(staffTarget.id, id)).limit(1);
    if (!before) fail("not_found", "That target no longer exists.");
    await assertStaff(tx, input.staffId);
    await assertNoOverlap(tx, input, id);
    await tx.update(staffTarget).set(input).where(eq(staffTarget.id, id));
    await recordAudit(tx, {
      actor,
      action: "target.updated",
      entityType: "staff_target",
      entityId: id,
      data: { before: { ...before, createdAt: undefined }, after: { ...input } },
    });
  });
}

export async function deleteTarget(db: Db, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(staffTarget).where(eq(staffTarget.id, id)).limit(1);
    if (!before) fail("not_found", "That target no longer exists.");
    await tx.delete(staffTarget).where(eq(staffTarget.id, id));
    await recordAudit(tx, {
      actor,
      action: "target.deleted",
      entityType: "staff_target",
      entityId: id,
      data: { ...before, createdAt: undefined },
    });
  });
}
