import { and, asc, eq, ne, sql } from "drizzle-orm";
import { staff } from "@/db/schema";
import type { Db } from "@/server/db-types";
import { getBusiness } from "@/server/admin-foundation/business";
import { lockStaffWrites } from "@/server/staff/lock";
import type { AccessSession } from "./access-core";
import { isOwnerEmail, normaliseEmail } from "./owners";

export interface SignedInUser {
  /** Better Auth user id. */
  id: string;
  email: string;
  /** Google profile name, used when an owner's staff row is created for the first time. */
  name?: string | null;
}

type StaffRow = typeof staff.$inferSelect;

const emailIs = (email: string) => sql`lower(${staff.email}) = ${email}`;

/** Active rows first, then the one already linked to this user, then the oldest. */
function pickRow(rows: readonly StaffRow[], userId: string): StaffRow | undefined {
  return [...rows].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const aLinked = a.userId === userId;
    if (aLinked !== (b.userId === userId)) return aLinked ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}

/** True when this email belongs to an active staff member. Used by the sign-in allow-list. */
export async function isActiveStaffEmail(db: Db, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(emailIs(normaliseEmail(email)), eq(staff.active, true)))
    .limit(1);
  return Boolean(row);
}

function toSession(user: SignedInUser, row: StaffRow, role: StaffRow["role"]): AccessSession {
  return { userId: user.id, email: user.email, staffId: row.id, role, name: row.name };
}

/** Points the staff row at this Better Auth user, releasing the id if another row held it. */
async function linkUser(tx: Db, row: StaffRow, userId: string): Promise<void> {
  await tx
    .update(staff)
    .set({ userId: null })
    .where(and(eq(staff.userId, userId), ne(staff.id, row.id)));
  await tx.update(staff).set({ userId }).where(eq(staff.id, row.id));
}

/**
 * An OWNER_EMAILS address always signs in as an owner: its staff row is created, re-activated and
 * promoted as needed, so the environment (not the team list) is the authority on who owns the business.
 */
async function provisionOwner(db: Db, user: SignedInUser, email: string): Promise<AccessSession> {
  return db.transaction(async (tx) => {
    await lockStaffWrites(tx);
    const rows = await tx.select().from(staff).where(emailIs(email));
    const existing = pickRow(rows, user.id);
    if (existing) {
      if (!existing.active || existing.role !== "owner") {
        await tx
          .update(staff)
          .set({ active: true, role: "owner" })
          .where(eq(staff.id, existing.id));
      }
      if (existing.userId !== user.id) await linkUser(tx, existing, user.id);
      return toSession(user, existing, "owner");
    }
    const biz = await getBusiness(tx);
    const name = user.name?.trim() || email;
    const [created] = await tx
      .insert(staff)
      .values({ businessId: biz.id, name, email, role: "owner", userId: user.id })
      .returning();
    return toSession(user, created, "owner");
  });
}

/**
 * Turns a signed-in Google user into an access session, or null when they are not (or are no longer)
 * allowed in. Runs on every guarded request, so deactivating someone revokes access at their next click.
 * Writes only when something changed (first sign-in link, owner promotion).
 */
export async function resolveAccess(
  db: Db,
  user: SignedInUser,
  ownerEmails: ReadonlySet<string>,
): Promise<AccessSession | null> {
  const email = normaliseEmail(user.email);
  const rows = await db.select().from(staff).where(emailIs(email)).orderBy(asc(staff.createdAt));
  const row = pickRow(rows, user.id);

  if (isOwnerEmail(email, ownerEmails)) {
    if (row?.active && row.role === "owner" && row.userId === user.id) {
      return toSession(user, row, "owner");
    }
    return provisionOwner(db, user, email);
  }

  if (!row?.active) return null;
  if (row.userId !== user.id) {
    await db.transaction(async (tx) => {
      await lockStaffWrites(tx);
      await linkUser(tx, row, user.id);
    });
  }
  return toSession(user, row, row.role);
}
