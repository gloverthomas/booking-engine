import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { availabilityRule, rosterException, timeEntry } from "@/db/schema";
import { entriesCsv, summaryCsv } from "@/server/timesheets/csv";
import { getWeeklyTimesheet, getWeeklyTimesheets } from "@/server/timesheets/weekly";
import { staffIdsFor, timesheetScopeFor } from "@/server/timesheets/scope";
import { createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";
import "../reports/timeouts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let ana: { id: string };
let ben: { id: string };
const TZ = "Australia/Melbourne";
// Thursday 19 Nov 2026, 12:00 local (AEDT).
const NOW = () => new Date("2026-11-19T01:00:00Z");
const WEEK = "2026-11-16";
const d = (iso: string) => new Date(iso);

beforeAll(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
  ana = await createStaff(t.db, seed.biz.id, { name: "Ana", email: "ana@example.com" });
  ben = await createStaff(t.db, seed.biz.id, { name: "Ben", email: "ben@example.com" });
  // Ana is rostered Mon to Fri 9 to 17 (8h) at Northside; Ben has no roster.
  await t.db.insert(availabilityRule).values(
    [1, 2, 3, 4, 5].map((weekday) => ({
      staffId: ana.id,
      locationId: seed.loc.id,
      weekday,
      startMinute: 540,
      endMinute: 1020,
    })),
  );
  // Ana has Wednesday off.
  await t.db.insert(rosterException).values({ staffId: ana.id, date: "2026-11-18", kind: "off" });
  await t.db.insert(timeEntry).values([
    // Mon 9:00 to 17:30 with a 30 min break: 8h worked. Approved.
    {
      staffId: ana.id,
      locationId: seed.loc.id,
      clockIn: d("2026-11-15T22:00:00Z"),
      clockOut: d("2026-11-16T06:30:00Z"),
      breakMinutes: 30,
      approvedAt: d("2026-11-17T00:00:00Z"),
      approvedBy: "owner:x",
    },
    // Tue 9:00 to 15:00, 6h, awaiting approval.
    { staffId: ana.id, clockIn: d("2026-11-16T22:00:00Z"), clockOut: d("2026-11-17T04:00:00Z") },
    // Wed (her day off) 10:00 to 12:00 manual cover, note that looks like a formula.
    {
      staffId: ana.id,
      clockIn: d("2026-11-17T23:00:00Z"),
      clockOut: d("2026-11-18T01:00:00Z"),
      source: "manual" as const,
      note: '=HYPERLINK("http://evil")',
    },
    // Thu 9:00 and still clocked in at 12:00 (3h so far).
    { staffId: ana.id, clockIn: d("2026-11-18T22:00:00Z") },
    // Ben: a Sunday 20:00 to 23:00 shift (counts on Sunday).
    { staffId: ben.id, clockIn: d("2026-11-22T09:00:00Z"), clockOut: d("2026-11-22T12:00:00Z") },
    // Outside the week: must not count.
    { staffId: ana.id, clockIn: d("2026-11-09T22:00:00Z"), clockOut: d("2026-11-10T06:00:00Z") },
  ]);
});
afterAll(async () => {
  await t.client.close();
});

describe("getWeeklyTimesheet", () => {
  test("worked, rostered and difference for a person", async () => {
    const sheet = await getWeeklyTimesheet(
      t.db,
      { timezone: TZ, weekStart: WEEK, staffId: ana.id },
      NOW,
    );
    expect(sheet).not.toBeNull();
    const s = sheet!;
    const byDate = Object.fromEntries(s.days.map((day) => [day.date, day]));

    expect(byDate["2026-11-16"]).toMatchObject({
      workedMinutes: 480,
      rosteredMinutes: 480,
      differenceMinutes: 0,
      complete: true,
    });
    expect(byDate["2026-11-17"]).toMatchObject({ workedMinutes: 360, differenceMinutes: -120 });
    // Day off: rostered 0, worked 2h, so +2h.
    expect(byDate["2026-11-18"]).toMatchObject({
      rosteredMinutes: 0,
      workedMinutes: 120,
      differenceMinutes: 120,
    });
    // Today: still clocked in, so no difference yet.
    expect(byDate["2026-11-19"]).toMatchObject({
      workedMinutes: 180,
      rosteredMinutes: 480,
      differenceMinutes: null,
      complete: false,
    });
    expect(byDate["2026-11-20"].differenceMinutes).toBeNull();

    expect(s.workedMinutes).toBe(480 + 360 + 120 + 180);
    expect(s.rosteredMinutes).toBe(4 * 480);
    expect(s.differenceMinutes).toBe(0 - 120 + 120);
    expect(s.hasOpenEntry).toBe(true);
    expect(s.pendingCount).toBe(2);
    expect(s.approvedCount).toBe(1);
    expect(s.breakMinutes).toBe(30);
  });

  test("a shift is counted on the local day it started and never twice", async () => {
    const sheet = await getWeeklyTimesheet(
      t.db,
      { timezone: TZ, weekStart: WEEK, staffId: ben.id },
      NOW,
    );
    const sunday = sheet!.days[6];
    expect(sunday.date).toBe("2026-11-22");
    expect(sunday.workedMinutes).toBe(180);
    expect(sheet!.workedMinutes).toBe(180);
  });

  test("an unknown person has no sheet", async () => {
    expect(
      await getWeeklyTimesheet(
        t.db,
        { timezone: TZ, weekStart: WEEK, staffId: "00000000-0000-4000-8000-000000000000" },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("getWeeklyTimesheets (team)", () => {
  test("lists every active person, sorted by name", async () => {
    const sheets = await getWeeklyTimesheets(t.db, { timezone: TZ, weekStart: WEEK }, NOW);
    expect(sheets.map((s) => s.staffName)).toEqual(["Ana", "Ben", "Ryan"]);
    expect(sheets.find((s) => s.staffName === "Ryan")?.workedMinutes).toBe(0);
  });

  test("an empty id list returns nothing", async () => {
    expect(
      await getWeeklyTimesheets(t.db, { timezone: TZ, weekStart: WEEK, staffIds: [] }),
    ).toEqual([]);
  });

  test("an inactive person shows only when they have time that week", async () => {
    const gone = await createStaff(t.db, seed.biz.id, {
      name: "Zed",
      email: "zed@example.com",
      active: false,
    });
    const without = await getWeeklyTimesheets(t.db, { timezone: TZ, weekStart: WEEK }, NOW);
    expect(without.map((s) => s.staffName)).not.toContain("Zed");
    await t.db.insert(timeEntry).values({
      staffId: gone.id,
      clockIn: d("2026-11-16T22:00:00Z"),
      clockOut: d("2026-11-17T01:00:00Z"),
    });
    const withTime = await getWeeklyTimesheets(t.db, { timezone: TZ, weekStart: WEEK }, NOW);
    expect(withTime.map((s) => s.staffName)).toContain("Zed");
  });

  test("a week that spans the DST change counts elapsed time and the shorter day", async () => {
    // Sunday 4 Oct 2026: Melbourne clocks go forward. Ana works 1:00 am AEST to 5:00 am AEDT = 3 real hours.
    await t.db.insert(timeEntry).values({
      staffId: ana.id,
      clockIn: d("2026-10-03T15:00:00Z"),
      clockOut: d("2026-10-03T18:00:00Z"),
    });
    const [sheet] = await getWeeklyTimesheets(
      t.db,
      { timezone: TZ, weekStart: "2026-09-28", staffIds: [ana.id] },
      NOW,
    );
    expect(sheet.days[6].date).toBe("2026-10-04");
    expect(sheet.days[6].workedMinutes).toBe(180);
  });
});

describe("scope", () => {
  test("only roles with timesheets.viewAll see the team", () => {
    expect(timesheetScopeFor("owner", null)).toEqual({ kind: "all" });
    expect(timesheetScopeFor("manager", "m1")).toEqual({ kind: "all" });
    expect(timesheetScopeFor("stylist", "s1")).toEqual({ kind: "own", staffId: "s1" });
    expect(timesheetScopeFor("reception", "r1")).toEqual({ kind: "own", staffId: "r1" });
    expect(timesheetScopeFor("stylist", null)).toEqual({ kind: "none" });
  });

  test("an own-only scope ignores a requested staff id", () => {
    expect(staffIdsFor({ kind: "own", staffId: "me" }, "someone-else")).toEqual(["me"]);
    expect(staffIdsFor({ kind: "all" })).toBe("all");
    expect(staffIdsFor({ kind: "all" }, "x")).toEqual(["x"]);
    expect(staffIdsFor({ kind: "none" }, "x")).toEqual([]);
  });
});

describe("CSV", () => {
  test("summary writes numbers as numbers, with a BOM and CRLF", async () => {
    const sheets = await getWeeklyTimesheets(
      t.db,
      { timezone: TZ, weekStart: WEEK, staffIds: [ana.id] },
      NOW,
    );
    const csv = summaryCsv(sheets);
    expect(csv.startsWith("﻿Staff,Week starting,Worked hours")).toBe(true);
    expect(csv.split("\r\n")[1]).toBe("Ana,2026-11-16,19.00,32.00,0.00,30,2,1");
  });

  test("entries neutralise formula text in notes and show local times", async () => {
    const sheets = await getWeeklyTimesheets(
      t.db,
      { timezone: TZ, weekStart: WEEK, staffIds: [ana.id] },
      NOW,
    );
    const csv = entriesCsv(sheets, TZ);
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain("Ana,2026-11-16,09:00,17:30,30,8.00,Northside,Clock,Approved");
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csv).toContain("Clocked in");
  });

  test("negative differences stay numeric", async () => {
    const sheets = await getWeeklyTimesheets(
      t.db,
      { timezone: TZ, weekStart: WEEK, staffIds: [ben.id] },
      NOW,
    );
    const csv = summaryCsv(sheets);
    expect(csv.split("\r\n")[1]).toBe("Ben,2026-11-16,3.00,0.00,0.00,0,1,0");
    const rows = summaryCsv([{ ...sheets[0], differenceMinutes: -90 }])
      .split("\r\n")[1]
      .split(",");
    expect(rows[4]).toBe("-1.50");
  });
});
