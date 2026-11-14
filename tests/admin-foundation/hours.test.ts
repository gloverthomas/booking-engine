import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";
import { auditLog, availabilityRule, booking, timeBlock } from "@/db/schema";
import {
  createTimeBlock,
  deleteTimeBlock,
  getWeeklyHours,
  listTimeBlocks,
  localInputToDate,
  saveWeeklyHours,
  toLocalInputValue,
} from "@/server/admin-foundation/hours";
import { rulesToWeek } from "@/server/admin-foundation/week";
import type { Actor } from "@/server/audit";

const actor: Actor = "owner:user-1";
const TZ = "Australia/Melbourne";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

describe("weekly hours", () => {
  let h: Harness;
  let fx: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    h = await createTestDb();
    fx = await seedBasics(h.db);
  });
  afterEach(async () => {
    await h.client.close();
  });

  test("saves a week of ranges, stored as local minutes, and reads it back", async () => {
    const week = rulesToWeek([
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
      { weekday: 6, startMinute: 540, endMinute: 960 },
    ]);
    await saveWeeklyHours(h.db, actor, { staffId: fx.stylist.id, locationId: fx.loc.id, week });
    const rows = await h.db.select().from(availabilityRule);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.validFrom === null && r.validTo === null)).toBe(true);
    expect(await getWeeklyHours(h.db, fx.stylist.id, fx.loc.id)).toEqual(week);
    const [entry] = await h.db.select().from(auditLog);
    expect(entry).toMatchObject({ actor: "owner:user-1", action: "hours.updated" });
  });

  test("saving replaces the previous week for that stylist and location only", async () => {
    const [other] = await h.db
      .insert((await import("@/db/schema")).location)
      .values({ businessId: fx.biz.id, name: "South side" })
      .returning();
    await saveWeeklyHours(h.db, actor, {
      staffId: fx.stylist.id,
      locationId: other!.id,
      week: rulesToWeek([{ weekday: 2, startMinute: 600, endMinute: 900 }]),
    });
    await saveWeeklyHours(h.db, actor, {
      staffId: fx.stylist.id,
      locationId: fx.loc.id,
      week: rulesToWeek([{ weekday: 1, startMinute: 540, endMinute: 1020 }]),
    });
    await saveWeeklyHours(h.db, actor, {
      staffId: fx.stylist.id,
      locationId: fx.loc.id,
      week: rulesToWeek([{ weekday: 3, startMinute: 540, endMinute: 1020 }]),
    });
    const here = await getWeeklyHours(h.db, fx.stylist.id, fx.loc.id);
    expect(here[1]).toEqual([]);
    expect(here[3]).toEqual([{ startMinute: 540, endMinute: 1020 }]);
    const there = await getWeeklyHours(h.db, fx.stylist.id, other!.id);
    expect(there[2]).toEqual([{ startMinute: 600, endMinute: 900 }]);
  });

  test("leaves date-bounded rules alone", async () => {
    await h.db.insert(availabilityRule).values({
      staffId: fx.stylist.id,
      locationId: fx.loc.id,
      weekday: 4,
      startMinute: 600,
      endMinute: 700,
      validFrom: "2030-01-01",
      validTo: "2030-02-01",
    });
    await saveWeeklyHours(h.db, actor, {
      staffId: fx.stylist.id,
      locationId: fx.loc.id,
      week: rulesToWeek([]),
    });
    expect(await h.db.select().from(availabilityRule)).toHaveLength(1);
  });

  test("rejects overlapping or reversed ranges without writing anything", async () => {
    const week = rulesToWeek([]);
    week[1] = [
      { startMinute: 540, endMinute: 700 },
      { startMinute: 600, endMinute: 800 },
    ];
    await expect(
      saveWeeklyHours(h.db, actor, { staffId: fx.stylist.id, locationId: fx.loc.id, week }),
    ).rejects.toThrow(/monday.*overlap/i);
    expect(await h.db.select().from(availabilityRule)).toHaveLength(0);
  });

  test("rejects an unknown stylist or location", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    await expect(
      saveWeeklyHours(h.db, actor, { staffId: missing, locationId: fx.loc.id, week: [] }),
    ).rejects.toThrow(/not found/i);
    await expect(
      saveWeeklyHours(h.db, actor, { staffId: fx.stylist.id, locationId: missing, week: [] }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("local date-time conversion", () => {
  test("interprets datetime-local values in the business timezone", () => {
    // Melbourne is UTC+11 in January (daylight saving), UTC+10 in July.
    expect(localInputToDate("2030-01-15T09:00", TZ)?.toISOString()).toBe(
      "2030-01-14T22:00:00.000Z",
    );
    expect(localInputToDate("2030-07-15T09:00", TZ)?.toISOString()).toBe(
      "2030-07-14T23:00:00.000Z",
    );
  });

  test("returns null for garbage", () => {
    expect(localInputToDate("not a date", TZ)).toBeNull();
    expect(localInputToDate("", TZ)).toBeNull();
  });

  test("formats a UTC instant back into the local input value", () => {
    expect(toLocalInputValue(new Date("2030-01-14T22:00:00.000Z"), TZ)).toBe("2030-01-15T09:00");
  });
});

describe("time off / blocked time", () => {
  let h: Harness;
  let fx: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    h = await createTestDb();
    fx = await seedBasics(h.db);
  });
  afterEach(async () => {
    await h.client.close();
  });

  test("creates a manual block from local times and audits it", async () => {
    const { id, conflictingBookings } = await createTimeBlock(
      h.db,
      actor,
      {
        staffId: fx.stylist.id,
        start: "2030-01-15T09:00",
        end: "2030-01-15T12:30",
        reason: "Dentist",
      },
      TZ,
    );
    expect(conflictingBookings).toBe(0);
    const [row] = await h.db.select().from(timeBlock).where(eq(timeBlock.id, id));
    expect(row?.source).toBe("manual");
    expect(row?.reason).toBe("Dentist");
    expect(row?.during.start.toISOString()).toBe("2030-01-14T22:00:00.000Z");
    expect(row?.during.end.toISOString()).toBe("2030-01-15T01:30:00.000Z");
    const entries = await h.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(entries[0]).toMatchObject({ action: "timeblock.created", actor: "owner:user-1" });
  });

  test("warns about, but does not block on, bookings already in the range", async () => {
    await h.db.insert(booking).values({
      staffId: fx.stylist.id,
      locationId: fx.loc.id,
      clientId: fx.cl.id,
      status: "confirmed",
      during: {
        start: new Date("2030-01-14T23:00:00Z"),
        end: new Date("2030-01-15T00:00:00Z"),
      },
    });
    await h.db.insert(booking).values({
      staffId: fx.stylist.id,
      locationId: fx.loc.id,
      clientId: fx.cl.id,
      status: "cancelled_by_client",
      during: {
        start: new Date("2030-01-15T00:00:00Z"),
        end: new Date("2030-01-15T01:00:00Z"),
      },
    });
    const result = await createTimeBlock(
      h.db,
      actor,
      { staffId: fx.stylist.id, start: "2030-01-15T09:00", end: "2030-01-15T12:30" },
      TZ,
    );
    expect(result.conflictingBookings).toBe(1);
  });

  test("validates the range and the stylist", async () => {
    const base = { staffId: fx.stylist.id, start: "2030-01-15T09:00", end: "2030-01-15T12:30" };
    await expect(
      createTimeBlock(h.db, actor, { ...base, end: "2030-01-15T09:00" }, TZ),
    ).rejects.toThrow(/after/i);
    await expect(createTimeBlock(h.db, actor, { ...base, start: "nonsense" }, TZ)).rejects.toThrow(
      /start/i,
    );
    await expect(
      createTimeBlock(
        h.db,
        actor,
        { ...base, staffId: "00000000-0000-0000-0000-000000000000" },
        TZ,
      ),
    ).rejects.toThrow(/not found/i);
    expect(await h.db.select().from(timeBlock)).toHaveLength(0);
  });

  test("lists upcoming manual blocks soonest first, hiding past and Google ones", async () => {
    const now = new Date("2030-01-10T00:00:00Z");
    const mk = (startIso: string, endIso: string, extra: Partial<typeof timeBlock.$inferInsert>) =>
      h.db.insert(timeBlock).values({
        staffId: fx.stylist.id,
        during: { start: new Date(startIso), end: new Date(endIso) },
        ...extra,
      });
    await mk("2030-01-20T00:00:00Z", "2030-01-21T00:00:00Z", { reason: "Later" });
    await mk("2030-01-12T00:00:00Z", "2030-01-13T00:00:00Z", { reason: "Sooner" });
    await mk("2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", { reason: "Past" });
    await mk("2030-01-15T00:00:00Z", "2030-01-16T00:00:00Z", {
      reason: "Busy",
      source: "google",
      externalId: "g1",
    });
    const blocks = await listTimeBlocks(h.db, now);
    expect(blocks.map((b) => b.reason)).toEqual(["Sooner", "Later"]);
    expect(blocks[0]?.staffName).toBe("Ryan");
  });

  test("deletes a manual block but refuses an imported Google one", async () => {
    const { id } = await createTimeBlock(
      h.db,
      actor,
      { staffId: fx.stylist.id, start: "2030-01-15T09:00", end: "2030-01-15T10:00" },
      TZ,
    );
    await deleteTimeBlock(h.db, actor, id);
    expect(await h.db.select().from(timeBlock)).toHaveLength(0);

    const [g] = await h.db
      .insert(timeBlock)
      .values({
        staffId: fx.stylist.id,
        during: { start: new Date("2030-01-15T00:00:00Z"), end: new Date("2030-01-15T01:00:00Z") },
        source: "google",
        externalId: "g1",
      })
      .returning();
    await expect(deleteTimeBlock(h.db, actor, g!.id)).rejects.toThrow(/google/i);
    await expect(
      deleteTimeBlock(h.db, actor, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/i);
  });
});
