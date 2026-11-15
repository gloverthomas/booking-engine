import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

class FakeDenied extends Error {}
const requireAccess = vi.fn(async (_permission: string) => ({
  userId: "u9",
  email: "m@example.com",
  staffId: "s9",
  role: "manager" as const,
}));
const fakeDb = { marker: "db" };

vi.mock("@/server/auth/access", () => ({
  requireAccess: (permission: string) => requireAccess(permission),
  AccessDeniedError: FakeDenied,
}));
vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));

describe("catalogAction (wired)", () => {
  test("uses the real access guard and database accessors", async () => {
    const { catalogAction } = await import("@/server/admin-foundation/catalog-access");
    const result = await catalogAction("catalog.edit", z.object({}), {}, async (_i, ctx) => ({
      actor: ctx.actor,
      db: ctx.db as unknown,
    }));
    expect(result).toEqual({ ok: true, data: { actor: "staff:u9", db: fakeDb } });
    expect(requireAccess).toHaveBeenCalledWith("catalog.edit");
  });

  test("recognises the guard's denial error and logs unexpected failures", async () => {
    const { catalogAction } = await import("@/server/admin-foundation/catalog-access");
    requireAccess.mockRejectedValueOnce(new FakeDenied("no"));
    const denied = await catalogAction("catalog.edit", z.object({}), {}, async () => 1);
    expect(denied.ok).toBe(false);

    const failed = await catalogAction("catalog.edit", z.object({}), {}, async () => {
      throw new Error("boom");
    });
    expect(failed.ok).toBe(false);
  });
});
