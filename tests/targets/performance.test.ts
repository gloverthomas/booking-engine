import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLog,
  availabilityRule,
  booking,
  bookingService,
  payment,
  staff,
  staffTarget,
} from "@/db/schema";
import { getRevenueReport } from "@/server/reports/revenue";
import { resolveRange } from "@/server/reports/range";
import { ReportAccessError } from "@/server/reports/scope";
import {
  createTargetCommand,
  deleteTargetCommand,
  updateTargetCommand,
} from "@/server/targets/commands";
import { createTarget, deleteTarget, listTargets, updateTarget } from "@/server/targets/crud";
import { getPerformance } from "@/server/targets/performance";
import { getRebookCounts } from "@/server/targets/rebook";
import { TargetError } from "@/server/targets/errors";
import { createTestDb } from "../helpers/test-db";
import "../reports/timeouts";
import { NOW, seedReportFixture, TZ, type Fixture } from "../reports/fixture";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let fx: Fixture;
let alexId: string;
const actor = "owner:o1" as const;

beforeAll(async () => {
  t = await createTestDb();
  fx = await seedReportFixture(t.db);
  const [alex] = await t.db
    .insert(staff)
    .values({ businessId: fx.businessId, name: "Alex Stylist", role: "stylist" })
    .returning();
  alexId = alex.id;
  // Receptionist: never listed as a stylist.
  await t.db
    .insert(staff)
    .values({ businessId: fx.businessId, name: "Rae Reception", role: "reception" });
  await t.db.insert(availabilityRule).values({
    staffId: alexId,
    locationId: fx.northside,
    weekday: 2,
    startMinute: 540,
    endMinute: 780,
  });
  // Alex: Tue 10 Nov 10:00 to 11:00 local, completed, $60 paid on the day.
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId: alexId,
      locationId: fx.northside,
      clientId: fx.clients.sam,
      status: "completed",
      during: { start: new Date("2026-11-09T23:00:00Z"), end: new Date("2026-11-10T00:00:00Z") },
      totalCents: 6000,
      depositCents: 0,
    })
    .returning();
  await t.db.insert(bookingService).values({
    bookingId: row.id,
    serviceId: fx.cutId,
    name: "Cut",
    durationMin: 60,
    priceCents: 6000,
  });
  await t.db.insert(payment).values({
    bookingId: row.id,
    kind: "balance",
    method: "cash",
    status: "succeeded",
    amountCents: 6000,
    createdAt: new Date("2026-11-10T02:00:00Z"),
  });
});
afterAll(async () => {
  await t.client.close();
});

describe("target CRUD", () => {
  const base = {
    staffId: null,
    metric: "revenue" as const,
    period: "month" as const,
    targetValue: 1_000_000,
    validFrom: "2026-01-01",
    validTo: null,
  };

  test("create, list, update and delete are audited", async () => {
    const id = await createTarget(t.db, { ...base, staffId: alexId }, actor);
    const listed = await listTargets(t.db);
    expect(listed.find((r) => r.id === id)).toMatchObject({
      staffName: "Alex Stylist",
      targetValue: 1_000_000,
    });

    await updateTarget(t.db, id, { ...base, staffId: alexId, targetValue: 1_200_000 }, actor);
    const [after] = await t.db.select().from(staffTarget).where(eq(staffTarget.id, id));
    expect(after.targetValue).toBe(1_200_000);

    await deleteTarget(t.db, id, actor);
    expect(await t.db.select().from(staffTarget).where(eq(staffTarget.id, id))).toHaveLength(0);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "target.created",
      "target.deleted",
      "target.updated",
    ]);
  });

  test("business-wide targets list before personal ones", async () => {
    const a = await createTarget(t.db, { ...base, metric: "bookings", targetValue: 20 }, actor);
    const b = await createTarget(
      t.db,
      { ...base, metric: "bookings", staffId: alexId, targetValue: 10 },
      actor,
    );
    const listed = await listTargets(t.db);
    const idx = (id: string) => listed.findIndex((r) => r.id === id);
    expect(idx(a)).toBeLessThan(idx(b));
    await deleteTarget(t.db, a, actor);
    await deleteTarget(t.db, b, actor);
  });

  test("rejects overlapping targets for the same person, measure and period, but not others", async () => {
    const id = await createTarget(
      t.db,
      { ...base, metric: "utilisation", targetValue: 7000, validTo: "2026-06-30" },
      actor,
    );
    await expect(
      createTarget(
        t.db,
        { ...base, metric: "utilisation", targetValue: 8000, validFrom: "2026-06-30" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "overlap" });
    // Next day is fine, a different person is fine, a different period type is fine.
    const next = await createTarget(
      t.db,
      { ...base, metric: "utilisation", targetValue: 8000, validFrom: "2026-07-01" },
      actor,
    );
    const other = await createTarget(
      t.db,
      { ...base, metric: "utilisation", staffId: alexId, targetValue: 8000 },
      actor,
    );
    const weekly = await createTarget(
      t.db,
      { ...base, metric: "utilisation", period: "week", targetValue: 8000 },
      actor,
    );
    // Updating a target to overlap another is refused, but saving it over itself is fine.
    await expect(
      updateTarget(
        t.db,
        id,
        { ...base, metric: "utilisation", targetValue: 7000, validTo: null },
        actor,
      ),
    ).rejects.toMatchObject({ code: "overlap" });
    await expect(
      updateTarget(
        t.db,
        id,
        { ...base, metric: "utilisation", targetValue: 7100, validTo: "2026-06-30" },
        actor,
      ),
    ).resolves.toBeUndefined();
    for (const x of [id, next, other, weekly]) await deleteTarget(t.db, x, actor);
  });

  test("validation: positive, within range, dates in order, real person, existing target", async () => {
    const code = async (p: Promise<unknown>) =>
      (
        (await p.then(
          () => null,
          (e: unknown) => e,
        )) as TargetError
      ).code;
    expect(await code(createTarget(t.db, { ...base, targetValue: 0 }, actor))).toBe(
      "bad_target_value",
    );
    expect(
      await code(
        createTarget(t.db, { ...base, metric: "utilisation", targetValue: 10_001 }, actor),
      ),
    ).toBe("bad_target_value");
    expect(await code(createTarget(t.db, { ...base, validTo: "2025-12-31" }, actor))).toBe(
      "bad_range",
    );
    expect(
      await code(
        createTarget(t.db, { ...base, staffId: "00000000-0000-4000-8000-000000000000" }, actor),
      ),
    ).toBe("unknown_staff");
    expect(
      await code(updateTarget(t.db, "00000000-0000-4000-8000-000000000000", base, actor)),
    ).toBe("not_found");
    expect(await code(deleteTarget(t.db, "00000000-0000-4000-8000-000000000000", actor))).toBe(
      "not_found",
    );
  });

  test("commands turn human text into stored units", async () => {
    const ctx = { db: t.db, actor };
    const { id } = await createTargetCommand(ctx, {
      staffId: alexId,
      metric: "rebook_rate",
      period: "month",
      targetValue: "62.5",
      validFrom: "2026-01-01",
      validTo: null,
    });
    const [row] = await t.db.select().from(staffTarget).where(eq(staffTarget.id, id));
    expect(row.targetValue).toBe(6250);
    await updateTargetCommand(ctx, {
      id,
      staffId: alexId,
      metric: "rebook_rate",
      period: "month",
      targetValue: "70",
      validFrom: "2026-01-01",
      validTo: null,
    });
    expect(
      (await t.db.select().from(staffTarget).where(eq(staffTarget.id, id)))[0].targetValue,
    ).toBe(7000);
    await expect(
      createTargetCommand(ctx, {
        staffId: null,
        metric: "bookings",
        period: "week",
        targetValue: "many",
        validFrom: "2026-01-01",
        validTo: null,
      }),
    ).rejects.toMatchObject({ code: "bad_target_value" });
    await deleteTargetCommand(ctx, { id });
  });
});

describe("rebook counts", () => {
  test("counts a visit as rebooked when the client books again within 28 days, only once the window has passed", async () => {
    const later = new Date("2026-12-20T00:00:00Z");
    // October: Sam's visit on 20 Oct was followed by 3 Nov (14 days later).
    const oct = await getRebookCounts(t.db, {
      range: resolveRange(TZ, "2026-10-01", "2026-10-31"),
      now: later,
    });
    expect(oct.total).toEqual({ eligible: 1, rebooked: 1 });
    expect(oct.byStaff.get(fx.staffId)).toEqual({ eligible: 1, rebooked: 1 });
    // August: Pat visited once and never came back.
    const aug = await getRebookCounts(t.db, {
      range: resolveRange(TZ, "2026-08-01", "2026-08-31"),
      now: later,
    });
    expect(aug.total).toEqual({ eligible: 1, rebooked: 0 });
    // November visits are too recent as of 14 Nov: not counted at all.
    const nov = await getRebookCounts(t.db, {
      range: resolveRange(TZ, "2026-11-01", "2026-11-30"),
      now: NOW,
    });
    expect(nov.total).toEqual({ eligible: 0, rebooked: 0 });
  });

  test("a staff filter keeps only that stylist's visits", async () => {
    const later = new Date("2026-12-20T00:00:00Z");
    const only = await getRebookCounts(t.db, {
      range: resolveRange(TZ, "2026-10-01", "2026-12-01"),
      now: later,
      staffId: alexId,
    });
    expect(only.byStaff.has(fx.staffId)).toBe(false);
    expect(only.byStaff.get(alexId)).toEqual({ eligible: 1, rebooked: 0 });
  });
});

describe("getPerformance", () => {
  let revenueTarget: string;
  let businessTarget: string;
  let util: string;
  beforeAll(async () => {
    revenueTarget = await createTarget(
      t.db,
      {
        staffId: alexId,
        metric: "revenue",
        period: "month",
        targetValue: 12_000,
        validFrom: "2026-01-01",
        validTo: null,
      },
      actor,
    );
    util = await createTarget(
      t.db,
      {
        staffId: alexId,
        metric: "utilisation",
        period: "month",
        targetValue: 1000,
        validFrom: "2026-01-01",
        validTo: null,
      },
      actor,
    );
    businessTarget = await createTarget(
      t.db,
      {
        staffId: null,
        metric: "bookings",
        period: "month",
        targetValue: 10,
        validFrom: "2026-01-01",
        validTo: null,
      },
      actor,
    );
  });

  const month = { timezone: TZ, period: "month" as const, now: NOW };

  test("actual vs target per stylist, revenue on a cash basis", async () => {
    const report = await getPerformance(t.db, { ...month, scope: { kind: "all" } });
    expect(report.range).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(report.ended).toBe(false);
    expect(report.elapsedPct).toBe(47);
    expect(report.rows.map((r) => r.name)).toEqual(["Alex Stylist", "Ryan"]); // reception is not listed

    const alex = report.rows[0];
    expect(alex.revenue).toMatchObject({ actual: 6000, target: 12_000 });
    expect(alex.revenue.progress).toMatchObject({ pct: 50, status: "on_pace" });
    expect(alex.bookings).toMatchObject({ actual: 1, target: null, progress: null });
    // 1 booked hour of 16 rostered hours (Tuesdays 3, 10, 17, 24 at 4h each) = 6.25% = 625 bps; target 10%.
    expect(alex.utilisation.actual).toBe(625);
    expect(alex.utilisation.progress).toMatchObject({ pct: 63, status: "on_pace" });
    expect(alex.rebookRate).toMatchObject({ actual: null, progress: null });
    expect(alex.detail).toMatchObject({ bookedHours: 1, rosteredHours: 16 });

    const ryanNet = (
      await getRevenueReport(t.db, {
        timezone: TZ,
        from: "2026-11-01",
        to: "2026-11-30",
        granularity: "month",
        groupBy: "staff",
        staffId: fx.staffId,
      })
    ).totals.netCents;
    expect(report.rows[1].revenue.actual).toBe(ryanNet);
  });

  test("the business row sums everyone and uses the business-wide targets", async () => {
    const report = await getPerformance(t.db, { ...month, scope: { kind: "all" } });
    const biz = report.business!;
    expect(biz.name).toBe("Whole business");
    expect(biz.bookings).toMatchObject({ actual: 5, target: 10 });
    expect(biz.bookings.progress).toMatchObject({ pct: 50, status: "on_pace" });
    expect(biz.revenue.actual).toBe(report.rows.reduce((s, r) => s + (r.revenue.actual ?? 0), 0));
    expect(biz.revenue.target).toBeNull();
  });

  test("a stylist sees only themselves and no business row", async () => {
    const report = await getPerformance(t.db, {
      ...month,
      scope: { kind: "own", staffId: alexId },
    });
    expect(report.rows.map((r) => r.name)).toEqual(["Alex Stylist"]);
    expect(report.business).toBeNull();
    expect(report.rows[0].revenue.actual).toBe(6000);
    expect(JSON.stringify(report)).not.toContain("Ryan");
  });

  test("a login with no staff profile cannot see performance", async () => {
    await expect(
      getPerformance(t.db, { ...month, scope: { kind: "none" } }),
    ).rejects.toBeInstanceOf(ReportAccessError);
  });

  test("a finished period marks a short target as missed, and a weekly view works", async () => {
    const oct = await getPerformance(t.db, {
      ...month,
      anchorDate: "2026-10-05",
      scope: { kind: "all" },
    });
    expect(oct.ended).toBe(true);
    expect(oct.elapsedPct).toBe(100);
    const week = await getPerformance(t.db, {
      timezone: TZ,
      period: "week",
      anchorDate: "2026-11-10",
      now: NOW,
      scope: { kind: "own", staffId: alexId },
    });
    expect(week.range).toMatchObject({ from: "2026-11-09", to: "2026-11-15" });
    expect(week.rows[0].revenue.actual).toBe(6000);
    // The monthly targets do not apply to a weekly view.
    expect(week.rows[0].revenue.target).toBeNull();
  });

  test("clean up", async () => {
    for (const id of [revenueTarget, businessTarget, util]) await deleteTarget(t.db, id, actor);
    expect(await t.db.select().from(staffTarget)).toHaveLength(0);
  });
});
