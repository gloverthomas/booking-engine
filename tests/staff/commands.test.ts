import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { session as authSession, user as authUser } from "@/db/auth-schema";
import { auditLog, business, staff } from "@/db/schema";
import { parseOwnerEmails } from "@/server/auth/owners";
import {
  createStaffMember,
  setStaffActive,
  updateStaffMember,
  type StaffCaller,
  type StaffCommandContext,
} from "@/server/staff/commands";
import { listStaff } from "@/server/staff/queries";
import { staffInputSchema, type StaffInput } from "@/server/staff/schemas";
import { createStaff } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

const input = (over: Partial<StaffInput> = {}): StaffInput => ({
  name: "Mia Chen",
  email: "mia@example.com",
  phone: "",
  role: "stylist",
  level: 0,
  colour: "",
  ...over,
});

describe("staff commands", () => {
  let h: Harness;
  let businessId: string;
  let ownerRow: typeof staff.$inferSelect;

  const ctxFor = (
    caller: StaffCaller,
    actor: StaffCommandContext["actor"] = "owner:u-owner",
    ownerEmails = "",
  ): StaffCommandContext => ({
    db: h.db,
    actor,
    caller,
    ownerEmails: parseOwnerEmails(ownerEmails),
  });
  const asOwner = () => ctxFor({ role: "owner", staffId: ownerRow.id });
  const asManager = () => ctxFor({ role: "manager", staffId: null }, "staff:u-mgr");
  const audits = (action?: string) =>
    h.db
      .select()
      .from(auditLog)
      .then((rows) => (action ? rows.filter((r) => r.action === action) : rows));

  beforeEach(async () => {
    h = await createTestDb();
    [{ id: businessId }] = await h.db.insert(business).values({ name: "Test" }).returning();
    ownerRow = await createStaff(h.db, businessId, {
      name: "Ryan",
      email: "ryan@example.com",
      role: "owner",
    });
  });
  afterEach(async () => {
    await h.client.close();
  });

  describe("create", () => {
    test("adds a team member and writes an audit row naming the actor", async () => {
      const { id } = await createStaffMember(
        asOwner(),
        input({ phone: "0400 000 000", colour: "#aabbcc", level: 2 }),
      );
      const [row] = await h.db.select().from(staff).where(eq(staff.id, id));
      expect(row).toMatchObject({
        name: "Mia Chen",
        email: "mia@example.com",
        phone: "0400 000 000",
        colour: "#aabbcc",
        level: 2,
        role: "stylist",
        active: true,
        businessId,
      });
      const [entry] = await audits("staff.created");
      expect(entry).toMatchObject({ actor: "owner:u-owner", entityType: "staff", entityId: id });
    });

    test("blank phone and colour are stored as null", async () => {
      const { id } = await createStaffMember(asOwner(), input());
      const [row] = await h.db.select().from(staff).where(eq(staff.id, id));
      expect(row.phone).toBeNull();
      expect(row.colour).toBeNull();
    });

    test("emails are unique among active staff, case-insensitively", async () => {
      await createStaffMember(asOwner(), input());
      await expect(
        createStaffMember(asOwner(), input({ name: "Other", email: "MIA@example.com" })),
      ).rejects.toMatchObject({ code: "email_taken", fieldErrors: { email: expect.any(String) } });
      expect(await h.db.select().from(staff)).toHaveLength(2);
    });

    test("a deactivated person's email can be used again", async () => {
      const old = await createStaff(h.db, businessId, { email: "mia@example.com", active: false });
      await expect(createStaffMember(asOwner(), input())).resolves.toBeDefined();
      expect(old.active).toBe(false);
    });

    test("a manager cannot create an owner, but can create everyone else", async () => {
      await expect(createStaffMember(asManager(), input({ role: "owner" }))).rejects.toMatchObject({
        code: "forbidden",
        fieldErrors: { role: expect.any(String) },
      });
      for (const role of ["manager", "stylist", "reception"] as const) {
        await createStaffMember(asManager(), input({ role, email: `${role}@example.com` }));
      }
      const [entry] = await audits("staff.created");
      expect(entry.actor).toBe("staff:u-mgr");
      expect(await h.db.select().from(staff)).toHaveLength(4);
    });

    test("an owner can create another owner", async () => {
      await createStaffMember(asOwner(), input({ role: "owner" }));
      expect((await h.db.select().from(staff).where(eq(staff.role, "owner"))).length).toBe(2);
    });

    test("cannot create a non-owner with an OWNER_EMAILS address", async () => {
      await expect(
        createStaffMember(
          ctxFor({ role: "owner", staffId: null }, "owner:x", "mia@example.com"),
          input(),
        ),
      ).rejects.toMatchObject({ code: "env_owner" });
    });
  });

  describe("update", () => {
    test("changes the fields, audits what changed and the role transition", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      await updateStaffMember(
        asOwner(),
        mia.id,
        input({ name: "Mia C", role: "manager", level: 3, phone: "0411", colour: "#112233" }),
      );
      const [row] = await h.db.select().from(staff).where(eq(staff.id, mia.id));
      expect(row).toMatchObject({ name: "Mia C", role: "manager", level: 3, phone: "0411" });
      const [entry] = await audits("staff.updated");
      expect(entry.data).toMatchObject({ roleFrom: "stylist", roleTo: "manager" });
      expect((entry.data as { changed: string[] }).changed).toEqual(
        expect.arrayContaining(["name", "role", "level", "phone", "colour"]),
      );
    });

    test("saving with no changes writes nothing", async () => {
      const mia = await createStaff(h.db, businessId, { name: "Mia Chen", email: "mia@example.com" });
      await updateStaffMember(asOwner(), mia.id, input());
      expect(await audits("staff.updated")).toHaveLength(0);
    });

    test("cannot take another active person's email", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      await expect(
        updateStaffMember(asOwner(), mia.id, input({ email: "RYAN@example.com" })),
      ).rejects.toMatchObject({ code: "email_taken" });
    });

    test("keeping their own email is not a clash", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      await expect(updateStaffMember(asOwner(), mia.id, input({ name: "New" }))).resolves.toBeUndefined();
    });

    test("an unknown id is a friendly not-found", async () => {
      await expect(
        updateStaffMember(asOwner(), "00000000-0000-4000-8000-000000000000", input()),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    test("a manager cannot edit an owner or grant owner", async () => {
      await expect(
        updateStaffMember(asManager(), ownerRow.id, input({ email: "ryan@example.com", role: "owner" })),
      ).rejects.toMatchObject({ code: "forbidden" });
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      await expect(
        updateStaffMember(asManager(), mia.id, input({ role: "owner" })),
      ).rejects.toMatchObject({ code: "forbidden" });
      const [row] = await h.db.select().from(staff).where(eq(staff.id, mia.id));
      expect(row.role).toBe("stylist");
    });

    test("a manager can edit non-owners", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      await updateStaffMember(asManager(), mia.id, input({ role: "reception" }));
      const [row] = await h.db.select().from(staff).where(eq(staff.id, mia.id));
      expect(row.role).toBe("reception");
    });

    test("the last active owner cannot be demoted, but can be once another owner exists", async () => {
      const demote = input({ name: "Ryan", email: "ryan@example.com", role: "manager" });
      await expect(updateStaffMember(asOwner(), ownerRow.id, demote)).rejects.toMatchObject({
        code: "last_owner",
      });
      await createStaff(h.db, businessId, { email: "second@example.com", role: "owner" });
      await expect(updateStaffMember(asOwner(), ownerRow.id, demote)).resolves.toBeUndefined();
    });

    test("an inactive second owner does not count as another owner", async () => {
      await createStaff(h.db, businessId, { email: "second@example.com", role: "owner", active: false });
      await expect(
        updateStaffMember(
          asOwner(),
          ownerRow.id,
          input({ name: "Ryan", email: "ryan@example.com", role: "stylist" }),
        ),
      ).rejects.toMatchObject({ code: "last_owner" });
    });

    test("an OWNER_EMAILS person cannot be demoted or re-emailed from the team list", async () => {
      const ctx = ctxFor({ role: "owner", staffId: null }, "owner:x", "ryan@example.com");
      await createStaff(h.db, businessId, { email: "second@example.com", role: "owner" });
      await expect(
        updateStaffMember(ctx, ownerRow.id, input({ email: "ryan@example.com", role: "manager" })),
      ).rejects.toMatchObject({ code: "env_owner" });
      await expect(
        updateStaffMember(ctx, ownerRow.id, input({ email: "new@example.com", role: "owner" })),
      ).rejects.toMatchObject({ code: "env_owner" });
      await expect(
        updateStaffMember(ctx, ownerRow.id, input({ name: "Ryan K", email: "ryan@example.com", role: "owner" })),
      ).resolves.toBeUndefined();
    });

    test("cannot move someone onto an OWNER_EMAILS address as a non-owner", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      const ctx = ctxFor({ role: "owner", staffId: null }, "owner:x", "boss@example.com");
      await expect(
        updateStaffMember(ctx, mia.id, input({ email: "boss@example.com" })),
      ).rejects.toMatchObject({ code: "env_owner" });
    });
  });

  describe("deactivate and reactivate", () => {
    test("deactivating audits, blocks nothing else, and ends their live sessions", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com", userId: "bu-1" });
      await h.db.insert(authUser).values({ id: "bu-1", name: "Mia", email: "mia@example.com" });
      await h.db.insert(authSession).values({
        id: "sess-1",
        token: "tok-1",
        userId: "bu-1",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      });
      await setStaffActive(asOwner(), mia.id, false);
      const [row] = await h.db.select().from(staff).where(eq(staff.id, mia.id));
      expect(row.active).toBe(false);
      expect(await h.db.select().from(authSession)).toHaveLength(0);
      expect(await audits("staff.deactivated")).toHaveLength(1);
    });

    test("a no-op toggle writes no audit row", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com" });
      await setStaffActive(asOwner(), mia.id, true);
      expect(await audits()).toHaveLength(0);
    });

    test("reactivating audits and enforces email uniqueness", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com", active: false });
      await createStaff(h.db, businessId, { email: "MIA@example.com", name: "Mia 2" });
      await expect(setStaffActive(asOwner(), mia.id, true)).rejects.toMatchObject({
        code: "email_taken",
      });
      const free = await createStaff(h.db, businessId, { email: "free@example.com", active: false });
      await setStaffActive(asOwner(), free.id, true);
      expect(await audits("staff.reactivated")).toHaveLength(1);
    });

    test("nobody can deactivate themselves", async () => {
      const mia = await createStaff(h.db, businessId, { email: "mia@example.com", role: "manager" });
      const self = ctxFor({ role: "manager", staffId: mia.id }, "staff:u-mia");
      await expect(setStaffActive(self, mia.id, false)).rejects.toMatchObject({ code: "forbidden" });
    });

    test("a manager cannot deactivate or reactivate an owner", async () => {
      const second = await createStaff(h.db, businessId, { email: "second@example.com", role: "owner" });
      await expect(setStaffActive(asManager(), second.id, false)).rejects.toMatchObject({
        code: "forbidden",
      });
      await h.db.update(staff).set({ active: false }).where(eq(staff.id, second.id));
      await expect(setStaffActive(asManager(), second.id, true)).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    test("the last active owner can never be deactivated", async () => {
      const other = await createStaff(h.db, businessId, { email: "x@example.com", role: "manager" });
      const asOtherOwner = ctxFor({ role: "owner", staffId: other.id });
      await expect(setStaffActive(asOtherOwner, ownerRow.id, false)).rejects.toMatchObject({
        code: "last_owner",
      });
      await createStaff(h.db, businessId, { email: "second@example.com", role: "owner" });
      await expect(setStaffActive(asOtherOwner, ownerRow.id, false)).resolves.toBeUndefined();
    });

    test("an OWNER_EMAILS owner cannot be deactivated from the team list", async () => {
      const second = await createStaff(h.db, businessId, { email: "second@example.com", role: "owner" });
      const ctx = ctxFor({ role: "owner", staffId: second.id }, "owner:x", "ryan@example.com");
      await expect(setStaffActive(ctx, ownerRow.id, false)).rejects.toMatchObject({ code: "env_owner" });
    });
  });

  describe("listStaff", () => {
    test("lists active first by name, with Google status and no tokens", async () => {
      const mia = await createStaff(h.db, businessId, { name: "Mia", email: "mia@example.com", userId: "u9" });
      await createStaff(h.db, businessId, { name: "Zed", email: "z@example.com", active: false });
      const { integrationAccount } = await import("@/db/schema");
      await h.db.insert(integrationAccount).values({
        businessId,
        staffId: mia.id,
        provider: "google",
        status: "connected",
        externalAccountId: "mia@example.com",
        encryptedTokens: "ciphertext",
      });
      const list = await listStaff(h.db);
      expect(list.map((p) => p.name)).toEqual(["Mia", "Ryan", "Zed"]);
      expect(list[0]).toMatchObject({
        hasSignedIn: true,
        google: { status: "connected", calendar: "mia@example.com" },
      });
      expect(list[1].google).toBeNull();
      expect(list[1].hasSignedIn).toBe(false);
      expect(JSON.stringify(list)).not.toContain("ciphertext");
    });
  });
});

describe("staffInputSchema", () => {
  const base = { name: " Mia ", email: " Mia@Example.com ", role: "stylist", level: 1 };

  test("trims, lower-cases the email and defaults the optional fields", () => {
    expect(staffInputSchema.parse(base)).toEqual({
      name: "Mia",
      email: "mia@example.com",
      phone: "",
      role: "stylist",
      level: 1,
      colour: "",
    });
  });

  test.each([
    [{ name: "  " }, "name"],
    [{ email: "nope" }, "email"],
    [{ role: "admin" }, "role"],
    [{ level: -1 }, "level"],
    [{ level: 1.5 }, "level"],
    [{ colour: "red" }, "colour"],
  ])("rejects %j", (bad, field) => {
    const result = staffInputSchema.safeParse({ ...base, ...bad });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain(field);
  });

  test("accepts a hex colour", () => {
    expect(staffInputSchema.parse({ ...base, colour: "#A1b2C3" }).colour).toBe("#A1b2C3");
  });
});
