import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccessSession } from "@/server/auth/access-core";

const requireAccessSession = vi.fn();
vi.mock("@/server/auth/index", () => ({
  requireAccessSession: () => requireAccessSession(),
}));
vi.mock("@/db/client", () => ({ getDb: () => ({ fake: true }) }));

const reception: AccessSession = {
  userId: "u1",
  email: "r@example.com",
  staffId: "s1",
  role: "reception",
};

describe("requireAccess / requireStaffSession", () => {
  beforeEach(() => {
    requireAccessSession.mockReset();
  });

  test("requireAccess returns the session when the role has the permission", async () => {
    requireAccessSession.mockResolvedValue(reception);
    const { requireAccess } = await import("@/server/auth/access");
    await expect(requireAccess("waitlist.manage")).resolves.toBe(reception);
    await expect(requireAccess("calendar.viewOwn")).resolves.toBe(reception);
  });

  test("requireAccess throws AccessDeniedError when it does not", async () => {
    requireAccessSession.mockResolvedValue(reception);
    const { requireAccess, AccessDeniedError } = await import("@/server/auth/access");
    await expect(requireAccess("staff.manage")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  test("a sign-in redirect from the guard propagates", async () => {
    requireAccessSession.mockRejectedValue(new Error("NEXT_REDIRECT:/login"));
    const { requireAccess, requireStaffSession } = await import("@/server/auth/access");
    await expect(requireAccess("staff.manage")).rejects.toThrow("NEXT_REDIRECT");
    await expect(requireStaffSession()).rejects.toThrow("NEXT_REDIRECT");
  });

  test("requireStaffSession returns any allowed-in role without a permission check", async () => {
    requireAccessSession.mockResolvedValue(reception);
    const { requireStaffSession } = await import("@/server/auth/access");
    await expect(requireStaffSession()).resolves.toBe(reception);
  });

  test("the bound accessAction wrapper uses the real requireAccess and the actor for the role", async () => {
    requireAccessSession.mockResolvedValue(reception);
    const { accessAction } = await import("@/server/auth/run-action");
    const { z } = await import("zod");
    const ok = await accessAction("waitlist.manage", z.object({}), {}, async (_p, ctx) => ctx.actor);
    expect(ok).toEqual({ ok: true, data: "staff:u1" });
    const denied = await accessAction("settings.edit", z.object({}), {}, async () => "ran");
    expect(denied).toMatchObject({ ok: false });
  });
});
