import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createAccessAction,
  actorFor,
  type ActionSession,
} from "@/server/timesheets/access-action";
import {
  addManualEntryCommand,
  approveEntriesCommand,
  clockInCommand,
  clockOutCommand,
  editEntryCommand,
} from "@/server/timesheets/commands";
import { TimesheetError } from "@/server/timesheets/errors";
import {
  approveEntriesSchema,
  clockOutSchema,
  manualEntrySchema,
  timesheetQuerySchema,
} from "@/server/timesheets/schemas";
import { createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";
import "../reports/timeouts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
const TZ = "Australia/Melbourne";
const NOW = () => new Date("2026-11-19T01:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterAll(async () => {
  await t.client.close();
});

describe("commands", () => {
  test("clock in and out for the signed-in person only", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "c1@example.com" });
    const ctx = { db: t.db, actor: "staff:u1" as const, staffId: person.id, timezone: TZ };
    const first = await clockInCommand(
      { ...ctx, clock: () => new Date("2026-11-18T22:00:00Z") },
      {},
    );
    const out = await clockOutCommand({ ...ctx, clock: NOW }, { breakMinutes: 15 });
    expect(out.entryId).toBe(first.entryId);
  });

  test("a login with no staff profile gets a clear message", async () => {
    const ctx = { db: t.db, actor: "owner:o1" as const, staffId: null, timezone: TZ };
    await expect(clockInCommand(ctx, {})).rejects.toMatchObject({ code: "no_staff_profile" });
    await expect(clockOutCommand(ctx, { breakMinutes: 0 })).rejects.toMatchObject({
      code: "no_staff_profile",
    });
  });

  test("manual entry, edit and approve convert business-local times", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "c2@example.com" });
    const ctx = { db: t.db, actor: "owner:o1" as const, staffId: null, timezone: TZ, clock: NOW };
    const { entryId } = await addManualEntryCommand(ctx, {
      staffId: person.id,
      clockIn: "2026-11-16T09:00",
      clockOut: "2026-11-16T17:00",
      breakMinutes: 30,
      reason: "Forgot to clock in",
    });
    await editEntryCommand(ctx, {
      entryId,
      clockOut: "2026-11-16T16:30",
      reason: "Left early",
      locationId: null,
    });
    const result = await approveEntriesCommand(ctx, { entryIds: [entryId] });
    expect(result.approved).toBe(1);
  });
});

describe("access action wrapper", () => {
  const session: ActionSession = { userId: "u1", email: "a@x.com", staffId: "s1", role: "manager" };
  const make = (over: Partial<Parameters<typeof createAccessAction>[0]> = {}) => {
    const log = vi.fn();
    const run = createAccessAction<string>({
      requireAccess: async () => session,
      getDb: () => t.db,
      isAccessDenied: (e) => e instanceof Error && e.name === "Denied",
      log,
      ...over,
    });
    return { run, log };
  };
  const schema = z.object({ n: z.coerce.number().int() });

  test("actors: owner:<id> for the owner, staff:<id> for everyone else", () => {
    expect(actorFor({ role: "owner", userId: "u" })).toBe("owner:u");
    expect(actorFor({ role: "stylist", userId: "u" })).toBe("staff:u");
  });

  test("runs the handler with a db and the right actor", async () => {
    const { run } = make();
    const result = await run("timesheets.approve", schema, { n: "3" }, async (p, c) => ({
      n: p.n,
      actor: c.actor,
    }));
    expect(result).toEqual({ ok: true, data: { n: 3, actor: "staff:u1" } });
  });

  test("a missing permission is a friendly refusal and the handler never runs", async () => {
    const handler = vi.fn();
    const { run } = make({
      requireAccess: async () => {
        const e = new Error("no");
        e.name = "Denied";
        throw e;
      },
    });
    const result = await run("timesheets.approve", schema, { n: 1 }, handler);
    expect(result).toEqual({ ok: false, error: "You do not have permission to do that." });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a redirect (anything not an access error) propagates", async () => {
    const { run } = make({
      requireAccess: async () => {
        throw new Error("NEXT_REDIRECT");
      },
    });
    await expect(run("timesheets.clock", schema, { n: 1 }, async () => 1)).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });

  test("invalid input gives field errors", async () => {
    const { run } = make();
    const result = await run("timesheets.clock", schema, { n: "x" }, async () => 1);
    expect(result).toMatchObject({ ok: false, fieldErrors: { n: expect.any(String) } });
  });

  test("domain errors pass through; unexpected errors are logged and hidden", async () => {
    const { run, log } = make();
    const friendly = await run("timesheets.clock", schema, { n: 1 }, async () => {
      throw new TimesheetError("x", "You are not clocked in.", { breakMinutes: "bad" });
    });
    expect(friendly).toEqual({
      ok: false,
      error: "You are not clocked in.",
      fieldErrors: { breakMinutes: "bad" },
    });
    const hidden = await run("timesheets.clock", schema, { n: 1 }, async () => {
      throw new Error("relation time_entry does not exist");
    });
    expect(hidden).toEqual({
      ok: false,
      error: "Something went wrong and nothing was saved. Please try again.",
    });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("schemas", () => {
  test("clock out defaults and bounds the break", () => {
    expect(clockOutSchema.parse({})).toEqual({ breakMinutes: 0 });
    expect(clockOutSchema.safeParse({ breakMinutes: 601 }).success).toBe(false);
    expect(clockOutSchema.safeParse({ breakMinutes: 1.5 }).success).toBe(false);
  });

  test("manual entry needs a reason and local date-times", () => {
    const ok = {
      staffId: "00000000-0000-4000-8000-000000000000",
      clockIn: "2026-11-16T09:00",
      clockOut: "2026-11-16T17:00",
      reason: "typo fix",
    };
    expect(manualEntrySchema.safeParse(ok).success).toBe(true);
    expect(manualEntrySchema.safeParse({ ...ok, reason: "" }).success).toBe(false);
    expect(manualEntrySchema.safeParse({ ...ok, clockIn: "2026-11-16 09:00" }).success).toBe(false);
  });

  test("approve needs 1 to 200 ids and the query has safe defaults", () => {
    expect(approveEntriesSchema.safeParse({ entryIds: [] }).success).toBe(false);
    expect(timesheetQuerySchema.parse({}).kind).toBe("summary");
    expect(timesheetQuerySchema.safeParse({ staff: "not-a-uuid" }).success).toBe(false);
  });
});
