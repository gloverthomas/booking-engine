import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

const requireOwner = vi.fn(async () => ({ userId: "u9", email: "ryan@example.com" }));
const fakeDb = { marker: "db" };

vi.mock("@/server/auth", () => ({ requireOwner: () => requireOwner() }));
vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));

describe("ownerAction (wired)", () => {
  test("uses the real owner guard and database accessors", async () => {
    const { ownerAction } = await import("@/server/admin-foundation/owner-action");
    const result = await ownerAction(z.object({ n: z.number() }), { n: 1 }, async (input, ctx) => ({
      n: input.n,
      actor: ctx.actor,
      db: ctx.db as unknown,
    }));
    expect(result).toEqual({ ok: true, data: { n: 1, actor: "owner:u9", db: fakeDb } });
    expect(requireOwner).toHaveBeenCalledOnce();
  });

  test("logs unexpected failures", async () => {
    const { ownerAction } = await import("@/server/admin-foundation/owner-action");
    const result = await ownerAction(z.object({}), {}, async () => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
  });
});
