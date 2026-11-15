import { describe, expect, test, vi } from "vitest";
import {
  AccessDeniedError,
  ACCESS_DENIED_DIGEST,
  actorFor,
  assertAccess,
  hasPermission,
  type AccessSession,
} from "@/server/auth/access-core";
import { evaluateIdentityWithStaff, parseOwnerEmails } from "@/server/auth/owners";
import { createAccessAction } from "@/server/auth/access-action";
import type { Db } from "@/server/db-types";
import { z } from "zod";
import { AdminError } from "@/server/admin-foundation/errors";

const session = (role: AccessSession["role"]): AccessSession => ({
  userId: "u1",
  email: "x@example.com",
  staffId: "s1",
  role,
});

describe("hasPermission and assertAccess", () => {
  test("follows the role table", () => {
    expect(hasPermission("owner", "settings.edit")).toBe(true);
    expect(hasPermission("manager", "settings.edit")).toBe(false);
    expect(hasPermission("manager", "staff.manage")).toBe(true);
    expect(hasPermission("stylist", "staff.manage")).toBe(false);
  });

  test("viewAll implies viewOwn, so reception can open the calendar", () => {
    expect(hasPermission("reception", "calendar.viewOwn")).toBe(true);
    expect(hasPermission("reception", "roster.viewOwn")).toBe(true);
    expect(hasPermission("reception", "reports.viewOwn")).toBe(false);
    expect(hasPermission("stylist", "calendar.viewAll")).toBe(false);
  });

  test("assertAccess returns the session or throws AccessDeniedError with a stable digest", () => {
    const s = session("manager");
    expect(assertAccess(s, "catalog.edit")).toBe(s);
    try {
      assertAccess(s, "settings.edit");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).permission).toBe("settings.edit");
      expect((error as AccessDeniedError).digest).toBe(ACCESS_DENIED_DIGEST);
    }
  });

  test("actorFor: owner:<id> for owners, staff:<id> for everyone else", () => {
    expect(actorFor(session("owner"))).toBe("owner:u1");
    for (const role of ["manager", "stylist", "reception"] as const) {
      expect(actorFor(session(role))).toBe("staff:u1");
    }
  });
});

describe("evaluateIdentityWithStaff", () => {
  const owners = parseOwnerEmails("ryan@example.com");
  const staffEmails = new Set(["mia@example.com"]);
  const isStaff = async (email: string) => staffEmails.has(email);

  test("admits owners and active staff, refuses strangers", async () => {
    expect(await evaluateIdentityWithStaff({ email: "Ryan@example.com" }, owners, isStaff)).toBeNull();
    expect(await evaluateIdentityWithStaff({ email: "MIA@example.com" }, owners, isStaff)).toBeNull();
    expect(await evaluateIdentityWithStaff({ email: "x@example.com" }, owners, isStaff)).toMatchObject({
      error: "not_authorised",
    });
    expect(await evaluateIdentityWithStaff({ email: null }, owners, isStaff)).toMatchObject({
      error: "not_authorised",
    });
  });

  test("still insists on a verified email for staff", async () => {
    expect(
      await evaluateIdentityWithStaff({ email: "mia@example.com", emailVerified: false }, owners, isStaff),
    ).toMatchObject({ error: "email_not_verified" });
  });

  test("an unverified owner email is refused without asking the staff list", async () => {
    const lookup = vi.fn(async () => true);
    expect(
      await evaluateIdentityWithStaff({ email: "ryan@example.com", emailVerified: false }, owners, lookup),
    ).toMatchObject({ error: "email_not_verified" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("createAccessAction", () => {
  const db = {} as Db;
  const schema = z.object({ n: z.number().int() });

  function setup(role: AccessSession["role"] | "denied" | "signedOut") {
    const log = vi.fn();
    const requireAccess = vi.fn(async (permission: Parameters<typeof assertAccess>[1]) => {
      if (role === "signedOut") throw new Error("NEXT_REDIRECT");
      return assertAccess(session(role === "denied" ? "stylist" : role), permission);
    });
    return { action: createAccessAction({ requireAccess, getDb: () => db, log }), log, requireAccess };
  }

  test("runs the handler with the db and a role-based actor", async () => {
    const owner = setup("owner");
    const result = await owner.action("settings.edit", schema, { n: 1 }, async (p, ctx) => ({
      echoed: p.n,
      actor: ctx.actor,
      same: ctx.db === db,
    }));
    expect(result).toEqual({ ok: true, data: { echoed: 1, actor: "owner:u1", same: true } });

    const manager = setup("manager");
    const r2 = await manager.action("staff.manage", schema, { n: 2 }, async (_p, ctx) => ctx.actor);
    expect(r2).toEqual({ ok: true, data: "staff:u1" });
  });

  test("a missing permission is a form-level answer and the handler never runs", async () => {
    const { action } = setup("denied");
    const handler = vi.fn(async () => "ran");
    const result = await action("staff.manage", schema, { n: 1 }, handler);
    expect(result).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a sign-in redirect propagates", async () => {
    const { action } = setup("signedOut");
    await expect(action("staff.manage", schema, { n: 1 }, async () => 1)).rejects.toThrow("NEXT_REDIRECT");
  });

  test("invalid input returns field errors and skips the handler", async () => {
    const { action } = setup("owner");
    const handler = vi.fn(async () => 1);
    const result = await action("settings.edit", schema, { n: "x" }, handler);
    expect(result).toMatchObject({ ok: false, fieldErrors: { n: expect.any(String) } });
    expect(handler).not.toHaveBeenCalled();
  });

  test("AdminError messages and field errors reach the user; anything else is generic and logged", async () => {
    const { action, log } = setup("owner");
    const friendly = await action("settings.edit", schema, { n: 1 }, async () => {
      throw new AdminError("x", "Nope", { email: "Taken" });
    });
    expect(friendly).toEqual({ ok: false, error: "Nope", fieldErrors: { email: "Taken" } });
    const plain = await action("settings.edit", schema, { n: 1 }, async () => {
      throw new AdminError("x", "Plain");
    });
    expect(plain).toEqual({ ok: false, error: "Plain" });
    const generic = await action("settings.edit", schema, { n: 1 }, async () => {
      throw new Error("secret detail");
    });
    expect(generic).toMatchObject({ ok: false });
    expect(JSON.stringify(generic)).not.toContain("secret detail");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: "secret detail" }));
  });
});
