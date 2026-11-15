import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, location, timeEntry } from "@/db/schema";
import {
  clockIn,
  clockOut,
  getClockState,
  getOpenEntry,
  isUniqueViolation,
} from "@/server/timesheets/clock";
import { TimesheetError } from "@/server/timesheets/errors";
import { createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";
import "../reports/timeouts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
const actor = "staff:user-1" as const;
const at = (iso: string) => () => new Date(iso);

beforeAll(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterAll(async () => {
  await t.client.close();
});

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TimesheetError);
  expect((error as TimesheetError).code).toBe(code);
}

describe("clock in and out", () => {
  test("clock in then out records the shift and audits both", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "a@example.com" });
    const entry = await clockIn(
      t.db,
      { staffId: person.id, locationId: seed.loc.id, actor },
      at("2026-11-16T22:02:00Z"),
    );
    expect(entry.clockOut).toBeNull();
    expect(entry.source).toBe("clock");
    expect((await getOpenEntry(t.db, person.id))?.id).toBe(entry.id);

    const done = await clockOut(
      t.db,
      { staffId: person.id, breakMinutes: 30, actor },
      at("2026-11-17T06:32:00Z"),
    );
    expect(done.clockOut?.toISOString()).toBe("2026-11-17T06:32:00.000Z");
    expect(done.breakMinutes).toBe(30);
    expect(await getOpenEntry(t.db, person.id)).toBeNull();

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, entry.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "timesheet.clock_in",
      "timesheet.clock_out",
    ]);
    expect(audits.every((a) => a.actor === actor)).toBe(true);
  });

  test("a second clock-in is refused with a friendly error", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "b@example.com" });
    await clockIn(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z"));
    await expectCode(
      clockIn(t.db, { staffId: person.id, actor }, at("2026-11-16T23:00:00Z")),
      "already_clocked_in",
    );
  });

  test("two taps racing each other: the database rule is translated, not leaked", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "c@example.com" });
    const results = await Promise.allSettled([
      clockIn(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z")),
      clockIn(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z")),
    ]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(TimesheetError);
  });

  test("clock-out without clock-in is rejected", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "d@example.com" });
    await expectCode(
      clockOut(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z")),
      "not_clocked_in",
    );
  });

  test("clock-out at or before clock-in is rejected and the entry stays open", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "e@example.com" });
    await clockIn(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z"));
    await expectCode(
      clockOut(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z")),
      "clock_out_before_in",
    );
    await expectCode(
      clockOut(t.db, { staffId: person.id, actor }, at("2026-11-16T21:00:00Z")),
      "clock_out_before_in",
    );
    expect(await getOpenEntry(t.db, person.id)).not.toBeNull();
  });

  test("break must be sensible", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "f@example.com" });
    await clockIn(t.db, { staffId: person.id, actor }, at("2026-11-16T22:00:00Z"));
    await expectCode(
      clockOut(t.db, { staffId: person.id, breakMinutes: -5, actor }, at("2026-11-17T06:00:00Z")),
      "bad_break",
    );
    await expectCode(
      clockOut(t.db, { staffId: person.id, breakMinutes: 90, actor }, at("2026-11-16T22:30:00Z")),
      "bad_break",
    );
  });

  test("location is optional but must be an active location when given", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "g@example.com" });
    const [closed] = await t.db
      .insert(location)
      .values({ businessId: seed.biz.id, name: "Closed", active: false })
      .returning();
    await expectCode(
      clockIn(t.db, { staffId: person.id, locationId: closed.id, actor }),
      "unknown_location",
    );
    await expectCode(
      clockIn(t.db, {
        staffId: person.id,
        locationId: "00000000-0000-4000-8000-000000000000",
        actor,
      }),
      "unknown_location",
    );
    const entry = await clockIn(t.db, { staffId: person.id, actor });
    expect(entry.locationId).toBeNull();
  });

  test("an inactive or unknown person cannot clock in", async () => {
    const gone = await createStaff(t.db, seed.biz.id, { email: "h@example.com", active: false });
    await expectCode(clockIn(t.db, { staffId: gone.id, actor }), "unknown_staff");
    await expectCode(
      clockIn(t.db, { staffId: "00000000-0000-4000-8000-000000000000", actor }),
      "unknown_staff",
    );
  });

  test("a shift across the DST start is 1h shorter on the wall clock but correct in elapsed time", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "i@example.com" });
    // Melbourne 1:00 am AEST on Sun 4 Oct 2026 to 5:00 am AEDT: four wall-clock hours, three elapsed.
    await clockIn(t.db, { staffId: person.id, actor }, at("2026-10-03T15:00:00Z"));
    const done = await clockOut(t.db, { staffId: person.id, actor }, at("2026-10-03T18:00:00Z"));
    expect((done.clockOut!.getTime() - done.clockIn.getTime()) / 3_600_000).toBe(3);
  });
});

describe("getClockState", () => {
  test("reports the open shift, its location name and the active locations", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "j@example.com" });
    const empty = await getClockState(t.db, person.id);
    expect(empty.open).toBeNull();
    expect(empty.locations.map((l) => l.name)).toContain("Northside");
    expect(empty.locations.map((l) => l.name)).not.toContain("Closed");

    await clockIn(
      t.db,
      { staffId: person.id, locationId: seed.loc.id, actor },
      at("2026-11-16T22:00:00Z"),
    );
    const state = await getClockState(t.db, person.id);
    expect(state.open).toMatchObject({ locationId: seed.loc.id, locationName: "Northside" });
  });
});

describe("isUniqueViolation", () => {
  test("finds the Postgres code anywhere in the cause chain", () => {
    expect(isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(true);
    expect(isUniqueViolation({ code: "23514" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  test("a real duplicate insert is recognised", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "k@example.com" });
    await t.db
      .insert(timeEntry)
      .values({ staffId: person.id, clockIn: new Date("2026-11-16T22:00:00Z") });
    const error = await t.db
      .insert(timeEntry)
      .values({ staffId: person.id, clockIn: new Date("2026-11-16T23:00:00Z") })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isUniqueViolation(error)).toBe(true);
  });
});
