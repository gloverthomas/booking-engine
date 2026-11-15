import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { staff } from "@/db/schema";
import { isActiveStaffEmail, resolveAccess } from "@/server/auth/resolve-access";
import { parseOwnerEmails } from "@/server/auth/owners";
import { createStaff } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";
import { business } from "@/db/schema";

type Harness = Awaited<ReturnType<typeof createTestDb>>;
const owners = parseOwnerEmails("ryan@example.com");

describe("resolveAccess", () => {
  let h: Harness;
  let businessId: string;

  beforeEach(async () => {
    h = await createTestDb();
    [{ id: businessId }] = await h.db.insert(business).values({ name: "Test" }).returning();
  });
  afterEach(async () => {
    await h.client.close();
  });

  const rows = () => h.db.select().from(staff);

  test("an OWNER_EMAILS address with no staff row gets an owner row named from the Google profile", async () => {
    const session = await resolveAccess(
      h.db,
      { id: "u1", email: "Ryan@Example.com", name: "Ryan K" },
      owners,
    );
    const [row] = await rows();
    expect(row).toMatchObject({
      name: "Ryan K",
      email: "ryan@example.com",
      role: "owner",
      userId: "u1",
      active: true,
      businessId,
    });
    expect(session).toEqual({
      userId: "u1",
      email: "Ryan@Example.com",
      staffId: row.id,
      role: "owner",
      name: "Ryan K",
    });
  });

  test("falls back to the email as the name when Google gives none", async () => {
    await resolveAccess(h.db, { id: "u1", email: "ryan@example.com" }, owners);
    expect((await rows())[0].name).toBe("ryan@example.com");
  });

  test("an owner email with an existing row is forced to owner, reactivated and linked, without a duplicate", async () => {
    const existing = await createStaff(h.db, businessId, {
      name: "Ryan",
      email: "RYAN@example.com",
      role: "stylist",
      active: false,
    });
    const session = await resolveAccess(h.db, { id: "u1", email: "ryan@example.com" }, owners);
    expect(session).toMatchObject({ role: "owner", staffId: existing.id });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ role: "owner", active: true, userId: "u1" });
  });

  test("a settled owner row is returned without writing", async () => {
    await resolveAccess(h.db, { id: "u1", email: "ryan@example.com" }, owners);
    const before = await rows();
    await resolveAccess(h.db, { id: "u1", email: "ryan@example.com" }, owners);
    expect(await rows()).toEqual(before);
  });

  test("an active staff member signs in with their row's role and gets linked on first sign-in", async () => {
    const mia = await createStaff(h.db, businessId, {
      name: "Mia",
      email: "Mia@Example.com",
      role: "manager",
    });
    const session = await resolveAccess(h.db, { id: "u2", email: "mia@example.com" }, owners);
    expect(session).toEqual({
      userId: "u2",
      email: "mia@example.com",
      staffId: mia.id,
      role: "manager",
      name: "Mia",
    });
    const [row] = await h.db.select().from(staff).where(eq(staff.id, mia.id));
    expect(row.userId).toBe("u2");
  });

  test("a stale link to an old Better Auth user is replaced", async () => {
    const mia = await createStaff(h.db, businessId, { email: "mia@example.com", userId: "old" });
    await resolveAccess(h.db, { id: "new", email: "mia@example.com" }, owners);
    const [row] = await h.db.select().from(staff).where(eq(staff.id, mia.id));
    expect(row.userId).toBe("new");
  });

  test("a deactivated or unknown person is refused on their very next request", async () => {
    const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
    expect(
      await resolveAccess(h.db, { id: "u2", email: "mia@example.com" }, owners),
    ).not.toBeNull();
    await h.db.update(staff).set({ active: false }).where(eq(staff.id, mia.id));
    expect(await resolveAccess(h.db, { id: "u2", email: "mia@example.com" }, owners)).toBeNull();
    expect(await resolveAccess(h.db, { id: "u9", email: "nobody@example.com" }, owners)).toBeNull();
  });

  test("when an inactive and an active row share an email, the active one wins", async () => {
    await createStaff(h.db, businessId, { name: "Old", email: "mia@example.com", active: false });
    const current = await createStaff(h.db, businessId, { name: "New", email: "mia@example.com" });
    const session = await resolveAccess(h.db, { id: "u2", email: "mia@example.com" }, owners);
    expect(session?.staffId).toBe(current.id);
  });

  test("with no OWNER_EMAILS a stranger is never promoted (fail closed)", async () => {
    expect(
      await resolveAccess(h.db, { id: "u1", email: "ryan@example.com" }, parseOwnerEmails("")),
    ).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  test("a user id already linked to a different row is released when relinking", async () => {
    const a = await createStaff(h.db, businessId, { email: "a@example.com", userId: "u7" });
    const b = await createStaff(h.db, businessId, { email: "b@example.com" });
    await resolveAccess(h.db, { id: "u7", email: "b@example.com" }, owners);
    const [rowA] = await h.db.select().from(staff).where(eq(staff.id, a.id));
    const [rowB] = await h.db.select().from(staff).where(eq(staff.id, b.id));
    expect(rowA.userId).toBeNull();
    expect(rowB.userId).toBe("u7");
  });

  test("isActiveStaffEmail is case-insensitive and ignores deactivated people", async () => {
    await createStaff(h.db, businessId, { email: "mia@example.com" });
    await createStaff(h.db, businessId, { email: "gone@example.com", active: false });
    expect(await isActiveStaffEmail(h.db, " MIA@example.com ")).toBe(true);
    expect(await isActiveStaffEmail(h.db, "gone@example.com")).toBe(false);
    expect(await isActiveStaffEmail(h.db, "who@example.com")).toBe(false);
  });
});
