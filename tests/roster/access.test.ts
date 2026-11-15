import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { AdminError } from "@/server/admin-foundation/errors";
import type { AccessSession } from "@/server/auth/access";
import { auditActorFor, rosterAccessFor } from "@/server/roster";
import { createAccessAction } from "@/server/roster/access-action";

describe("rosterAccessFor", () => {
  test("owner and manager see everyone and can edit", () => {
    expect(rosterAccessFor("owner")).toEqual({ scope: "all", canEdit: true });
    expect(rosterAccessFor("manager")).toEqual({ scope: "all", canEdit: true });
  });

  test("reception sees everyone but cannot edit", () => {
    expect(rosterAccessFor("reception")).toEqual({ scope: "all", canEdit: false });
  });

  test("a stylist sees only their own roster and cannot edit", () => {
    expect(rosterAccessFor("stylist")).toEqual({ scope: "own", canEdit: false });
  });
});

describe("auditActorFor", () => {
  test("owner:<id> for the owner, staff:<id> for everyone else", () => {
    expect(auditActorFor({ userId: "u1", role: "owner" })).toBe("owner:u1");
    expect(auditActorFor({ userId: "u2", role: "manager" })).toBe("staff:u2");
    expect(auditActorFor({ userId: "u3", role: "stylist" })).toBe("staff:u3");
  });
});

describe("createAccessAction", () => {
  const session: AccessSession = {
    userId: "u2",
    email: "m@example.com",
    staffId: "s1",
    role: "manager",
  };
  const db = { marker: "db" } as never;
  const schema = z.object({ n: z.number() });

  function make(grant: () => Promise<AccessSession> = async () => session) {
    const requireAccess = vi.fn(grant);
    const log = vi.fn();
    const action = createAccessAction({ requireAccess, getDb: () => db, log });
    return { action, requireAccess, log };
  }

  test("checks the permission, validates, and passes db, actor and session to the handler", async () => {
    const { action, requireAccess } = make();
    const result = await action("roster.editAll", schema, { n: 1 }, async (input, ctx) => ({
      n: input.n,
      actor: ctx.actor,
      db: ctx.db,
      role: ctx.session.role,
    }));
    expect(requireAccess).toHaveBeenCalledWith("roster.editAll");
    expect(result).toEqual({ ok: true, data: { n: 1, actor: "staff:u2", db, role: "manager" } });
  });

  test("returns field errors for invalid input without running the handler", async () => {
    const { action } = make();
    const handler = vi.fn();
    const result = await action("roster.editAll", schema, { n: "x" }, handler);
    expect(result).toMatchObject({ ok: false, fieldErrors: { n: expect.any(String) } });
    expect(handler).not.toHaveBeenCalled();
  });

  test("lets a denied permission propagate", async () => {
    const { action } = make(async () => {
      throw new Error("Not allowed: roster.editAll");
    });
    await expect(action("roster.editAll", schema, { n: 1 }, async () => 1)).rejects.toThrow(
      "Not allowed",
    );
  });

  test("turns an AdminError into a message (with field errors when present)", async () => {
    const { action } = make();
    const plain = await action("roster.editAll", schema, { n: 1 }, async () => {
      throw new AdminError("x", "Nope.");
    });
    expect(plain).toEqual({ ok: false, error: "Nope." });
    const withFields = await action("roster.editAll", schema, { n: 1 }, async () => {
      throw new AdminError("x", "Bad.", { date: "Invalid" });
    });
    expect(withFields).toEqual({ ok: false, error: "Bad.", fieldErrors: { date: "Invalid" } });
  });

  test("logs unexpected errors and returns a generic message", async () => {
    const { action, log } = make();
    const result = await action("roster.editAll", schema, { n: 1 }, async () => {
      throw new Error("boom");
    });
    expect(result).toMatchObject({ ok: false });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
  });
});

describe("rosterAction (wired)", () => {
  test("uses the real access guard and database accessors", async () => {
    vi.resetModules();
    const fakeDb = { marker: "wired" };
    vi.doMock("@/server/auth/access", () => ({
      requireAccess: async () => ({
        userId: "owner1",
        email: "o@example.com",
        staffId: null,
        role: "owner",
      }),
    }));
    vi.doMock("@/db/client", () => ({ getDb: () => fakeDb }));
    const { rosterAction } = await import("@/server/roster/access-action");
    const result = await rosterAction("roster.editAll", z.object({}), {}, async (_i, ctx) => ({
      actor: ctx.actor,
      db: ctx.db as unknown,
    }));
    expect(result).toEqual({ ok: true, data: { actor: "owner:owner1", db: fakeDb } });
    vi.doUnmock("@/server/auth/access");
    vi.doUnmock("@/db/client");
  });
});
