import { and, count, eq, ne, sql } from "drizzle-orm";
import { session as authSession } from "@/db/auth-schema";
import { staff } from "@/db/schema";
import { AdminError } from "@/server/admin-foundation/errors";
import { getBusiness } from "@/server/admin-foundation/business";
import { recordAudit, type Actor } from "@/server/audit";
import { isOwnerEmail } from "@/server/auth/owners";
import type { StaffRole } from "@/server/contracts";
import type { Db } from "@/server/db-types";
import { lockStaffWrites } from "./lock";
import type { StaffInput } from "./schemas";

/** Who is making the change. Managers are restricted from touching owners. */
export interface StaffCaller {
  role: StaffRole;
  /** The caller's own staff row, so nobody can deactivate themselves. */
  staffId: string | null;
}

export interface StaffCommandContext {
  db: Db;
  actor: Actor;
  caller: StaffCaller;
  /** OWNER_EMAILS: those people are owners whatever the team list says. */
  ownerEmails: ReadonlySet<string>;
}

type StaffRow = typeof staff.$inferSelect;

const emailIs = (email: string) => sql`lower(${staff.email}) = ${email}`;

function forbidden(message: string): AdminError {
  return new AdminError("forbidden", message);
}

function requireRowFound(row: StaffRow | undefined): StaffRow {
  if (!row) throw new AdminError("not_found", "That team member no longer exists.");
  return row;
}

async function loadStaff(tx: Db, id: string): Promise<StaffRow> {
  const [row] = await tx.select().from(staff).where(eq(staff.id, id));
  return requireRowFound(row);
}

/** Managers run the team but cannot create, edit, deactivate or promote to owner. */
function assertMayTouchOwners(ctx: StaffCommandContext, target: { role: StaffRole } | null, nextRole?: StaffRole) {
  if (ctx.caller.role === "owner") return;
  if (target?.role === "owner") {
    throw forbidden("Only an owner can change an owner.");
  }
  if (nextRole === "owner") {
    throw new AdminError("forbidden", "Only an owner can make someone an owner.", {
      role: "Only an owner can grant the owner role.",
    });
  }
}

async function assertEmailFree(tx: Db, email: string, exceptId?: string): Promise<void> {
  const clash = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        emailIs(email),
        eq(staff.active, true),
        exceptId ? ne(staff.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (clash.length > 0) {
    throw new AdminError("email_taken", "Someone on the team already uses that email.", {
      email: "Someone on the team already uses that email.",
    });
  }
}

/** The environment decides who owns the business, so the team list cannot demote those emails. */
function assertEnvOwnerRole(ctx: StaffCommandContext, email: string, role: StaffRole): void {
  if (role !== "owner" && isOwnerEmail(email, ctx.ownerEmails)) {
    throw new AdminError("env_owner", "That email is an owner of the business.", {
      role: "This email is set as an owner on the server (OWNER_EMAILS), so it always signs in as an owner.",
    });
  }
}

/** At least one other active owner must remain. */
async function assertAnotherOwnerRemains(tx: Db, exceptId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(staff)
    .where(and(eq(staff.role, "owner"), eq(staff.active, true), ne(staff.id, exceptId)));
  if ((row?.n ?? 0) < 1) {
    throw new AdminError(
      "last_owner",
      "There must always be an active owner. Make someone else an owner first.",
    );
  }
}

function nullIfBlank(value: string): string | null {
  return value === "" ? null : value;
}

export async function createStaffMember(
  ctx: StaffCommandContext,
  input: StaffInput,
): Promise<{ id: string }> {
  assertMayTouchOwners(ctx, null, input.role);
  return ctx.db.transaction(async (tx) => {
    await lockStaffWrites(tx);
    assertEnvOwnerRole(ctx, input.email, input.role);
    await assertEmailFree(tx, input.email);
    const biz = await getBusiness(tx);
    const [created] = await tx
      .insert(staff)
      .values({
        businessId: biz.id,
        name: input.name,
        email: input.email,
        phone: nullIfBlank(input.phone),
        role: input.role,
        level: input.level,
        colour: nullIfBlank(input.colour),
      })
      .returning({ id: staff.id });
    await recordAudit(tx, {
      actor: ctx.actor,
      action: "staff.created",
      entityType: "staff",
      entityId: created.id,
      data: { role: input.role, level: input.level },
    });
    return { id: created.id };
  });
}

export async function updateStaffMember(
  ctx: StaffCommandContext,
  id: string,
  input: StaffInput,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await lockStaffWrites(tx);
    const target = await loadStaff(tx, id);
    assertMayTouchOwners(ctx, target, input.role);

    const targetEmail = target.email?.toLowerCase() ?? "";
    const isEnvOwner = isOwnerEmail(targetEmail, ctx.ownerEmails);
    if (isEnvOwner && input.role !== "owner") {
      throw new AdminError("env_owner", "That person is an owner of the business.", {
        role: "This person is set as an owner on the server (OWNER_EMAILS), so they always sign in as an owner.",
      });
    }
    if (isEnvOwner && input.email !== targetEmail) {
      throw new AdminError("env_owner", "That person's email is set on the server.", {
        email: "This owner's email is set on the server (OWNER_EMAILS). Change it there.",
      });
    }
    assertEnvOwnerRole(ctx, input.email, input.role);

    if (target.active) {
      if (target.role === "owner" && input.role !== "owner") {
        await assertAnotherOwnerRemains(tx, target.id);
      }
      if (input.email !== targetEmail) await assertEmailFree(tx, input.email, target.id);
    }

    const next = {
      name: input.name,
      email: input.email,
      phone: nullIfBlank(input.phone),
      role: input.role,
      level: input.level,
      colour: nullIfBlank(input.colour),
    };
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (key) => next[key] !== target[key],
    );
    if (changed.length === 0) return;

    await tx.update(staff).set(next).where(eq(staff.id, id));
    await recordAudit(tx, {
      actor: ctx.actor,
      action: "staff.updated",
      entityType: "staff",
      entityId: id,
      data: {
        changed,
        ...(target.role !== input.role ? { roleFrom: target.role, roleTo: input.role } : {}),
      },
    });
  });
}

export async function setStaffActive(
  ctx: StaffCommandContext,
  id: string,
  active: boolean,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await lockStaffWrites(tx);
    const target = await loadStaff(tx, id);
    if (target.active === active) return;
    assertMayTouchOwners(ctx, target);

    if (active) {
      if (target.email) await assertEmailFree(tx, target.email.toLowerCase(), target.id);
    } else {
      if (ctx.caller.staffId === target.id) {
        throw forbidden("You can't deactivate yourself.");
      }
      if (isOwnerEmail(target.email, ctx.ownerEmails)) {
        throw new AdminError(
          "env_owner",
          "That person is an owner set on the server (OWNER_EMAILS). Remove their email there to take their access away.",
        );
      }
      if (target.role === "owner") await assertAnotherOwnerRemains(tx, target.id);
    }

    await tx.update(staff).set({ active }).where(eq(staff.id, id));
    if (!active && target.userId) {
      // Belt and braces: the guard already refuses them, but end any live sessions too.
      await tx.delete(authSession).where(eq(authSession.userId, target.userId));
    }
    await recordAudit(tx, {
      actor: ctx.actor,
      action: active ? "staff.reactivated" : "staff.deactivated",
      entityType: "staff",
      entityId: id,
      data: { role: target.role },
    });
  });
}
