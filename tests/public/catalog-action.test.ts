import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  actorFor,
  createAccessAction,
  type AccessActionDeps,
} from "@/server/admin-foundation/catalog-action";
import { AdminError } from "@/server/admin-foundation/errors";

const fakeDb = { marker: "db" };

function deps(overrides: Partial<AccessActionDeps> = {}): AccessActionDeps {
  return {
    requireAccess: vi.fn(async () => ({
      userId: "u1",
      email: "ryan@example.com",
      staffId: null,
      role: "owner" as const,
    })),
    getDb: () => fakeDb as never,
    log: vi.fn(),
    isAccessDenied: () => false,
    ...overrides,
  };
}

const schema = z.object({ n: z.number() });

describe("actorFor", () => {
  test("owners are owner:<id>, everyone else is staff:<id>", () => {
    expect(actorFor({ userId: "u1", role: "owner" })).toBe("owner:u1");
    expect(actorFor({ userId: "u2", role: "manager" })).toBe("staff:u2");
    expect(actorFor({ userId: "u3", role: "stylist" })).toBe("staff:u3");
    expect(actorFor({ userId: "u4", role: "reception" })).toBe("staff:u4");
  });
});

describe("createAccessAction", () => {
  test("checks the permission, validates, and runs with the right actor and db", async () => {
    const d = deps();
    const run = createAccessAction(d);
    const result = await run("catalog.edit", schema, { n: 1 }, async (input, ctx) => ({
      n: input.n,
      actor: ctx.actor,
      db: ctx.db as unknown,
    }));
    expect(result).toEqual({ ok: true, data: { n: 1, actor: "owner:u1", db: fakeDb } });
    expect(d.requireAccess).toHaveBeenCalledWith("catalog.edit");
  });

  test("a manager is audited as staff:<id>", async () => {
    const run = createAccessAction(
      deps({
        requireAccess: async () => ({
          userId: "u2",
          email: "m@example.com",
          staffId: "s2",
          role: "manager" as const,
        }),
      }),
    );
    const result = await run("catalog.edit", schema, { n: 1 }, async (_i, ctx) => ctx.actor);
    expect(result).toEqual({ ok: true, data: "staff:u2" });
  });

  test("returns field errors without running the handler on bad input", async () => {
    const handler = vi.fn();
    const result = await createAccessAction(deps())("catalog.edit", schema, { n: "x" }, handler);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors).toHaveProperty("n");
      expect(result.error).toMatch(/highlighted/i);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  test("turns a denied permission into a plain message, never running anything", async () => {
    const denied = new Error("Not allowed: catalog.edit");
    const handler = vi.fn();
    const result = await createAccessAction(
      deps({
        requireAccess: async () => {
          throw denied;
        },
        isAccessDenied: (e) => e === denied,
      }),
    )("catalog.edit", schema, { n: 1 }, handler);
    expect(result).toEqual({
      ok: false,
      error: "You don't have permission to change the catalog.",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("lets other errors from the guard (such as a redirect to login) propagate", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    await expect(
      createAccessAction(
        deps({
          requireAccess: async () => {
            throw redirect;
          },
        }),
      )("catalog.edit", schema, { n: 1 }, async () => 1),
    ).rejects.toBe(redirect);
  });

  test("shows owner-fixable errors as they are, including field errors", async () => {
    const result = await createAccessAction(deps())("catalog.edit", schema, { n: 1 }, async () => {
      throw new AdminError("in_use", "It is in use.", { name: "Taken" });
    });
    expect(result).toEqual({ ok: false, error: "It is in use.", fieldErrors: { name: "Taken" } });
  });

  test("logs unexpected failures and hides the detail", async () => {
    const d = deps();
    const result = await createAccessAction(d)("catalog.edit", schema, { n: 1 }, async () => {
      throw new Error("secret detail");
    });
    expect(result).toEqual({
      ok: false,
      error: "Something went wrong and nothing was saved. Please try again.",
    });
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ event: "catalog_action_failed" }));
  });
});
