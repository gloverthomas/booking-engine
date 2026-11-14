import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createOwnerAction, type ActionContext } from "@/server/admin-foundation/action";
import { AdminError } from "@/server/admin-foundation/errors";
import type { Db } from "@/server/db-types";

class RedirectSignal extends Error {}

function setup(options: { signedIn?: boolean } = {}) {
  const db = {} as Db;
  const logged: unknown[] = [];
  const requireOwner = vi.fn(async () => {
    if (options.signedIn === false) throw new RedirectSignal("/login");
    return { userId: "user-7", email: "ryan@example.com" };
  });
  const action = createOwnerAction({
    requireOwner,
    getDb: () => db,
    log: (entry) => logged.push(entry),
  });
  return { action, requireOwner, db, logged };
}

const schema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  qty: z.number().int(),
});

describe("createOwnerAction", () => {
  test("checks the owner, validates, runs the handler with an owner:<id> actor and returns the data", async () => {
    const { action, db } = setup();
    let seen: ActionContext | undefined;
    const result = await action(schema, { name: " Widget ", qty: 2 }, async (input, ctx) => {
      seen = ctx;
      return { echoed: input.name };
    });
    expect(result).toEqual({ ok: true, data: { echoed: "Widget" } });
    expect(seen).toEqual({
      db,
      actor: "owner:user-7",
      owner: { userId: "user-7", email: "ryan@example.com" },
    });
  });

  test("never runs the handler for a signed-out caller; the redirect propagates", async () => {
    const { action } = setup({ signedIn: false });
    const handler = vi.fn(async () => "ran");
    await expect(action(schema, { name: "x", qty: 1 }, handler)).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test("returns field errors for invalid input and does not run the handler", async () => {
    const { action } = setup();
    const handler = vi.fn(async () => "ran");
    const result = await action(schema, { name: "", qty: 1.5 }, handler);
    expect(result).toEqual({
      ok: false,
      error: "Please fix the highlighted fields.",
      fieldErrors: { name: "Name is required", qty: expect.any(String) },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("rejects non-object input (e.g. a forged payload) as invalid", async () => {
    const { action } = setup();
    const result = await action(schema, "nope", async () => "ran");
    expect(result.ok).toBe(false);
  });

  test("surfaces AdminError messages and field errors to the user", async () => {
    const { action } = setup();
    const result = await action(schema, { name: "x", qty: 1 }, async () => {
      throw new AdminError("in_use", "It is in use. Deactivate it instead.", { name: "In use" });
    });
    expect(result).toEqual({
      ok: false,
      error: "It is in use. Deactivate it instead.",
      fieldErrors: { name: "In use" },
    });
  });

  test("hides unexpected errors behind a generic message and logs the detail", async () => {
    const { action, logged } = setup();
    const result = await action(schema, { name: "x", qty: 1 }, async () => {
      throw new Error("connection string postgres://secret");
    });
    expect(result).toEqual({
      ok: false,
      error: "Something went wrong and nothing was saved. Please try again.",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(logged).toHaveLength(1);
  });
});
