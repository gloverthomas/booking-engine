import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import "./timeouts";
import { getRevenueReport } from "@/server/reports/revenue";
import { ReportInputError } from "@/server/reports/range";
import { seedReportFixture, TZ, type Fixture } from "./fixture";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let fx: Fixture;

beforeAll(async () => {
  t = await createTestDb();
  fx = await seedReportFixture(t.db);
});
afterAll(async () => {
  await t.client.close();
});

const base = { timezone: TZ, from: "2026-11-01", to: "2026-11-30" } as const;

describe("getRevenueReport", () => {
  test("totals split deposits, balances, fees, refunds and fees kept", async () => {
    const r = await getRevenueReport(t.db, { ...base, granularity: "month", groupBy: "none" });
    expect(r.totals).toMatchObject({
      depositsCents: 30000,
      balancesCents: 11000,
      feeChargesCents: 1900,
      grossCents: 42900,
      refundsCents: 4750,
      netCents: 38150,
      forfeitedDepositsCents: 9500,
      feesKeptCents: 11400,
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].period).toBe("2026-11-01");
  });

  test("pending and failed payments never count", async () => {
    const r = await getRevenueReport(t.db, { ...base, granularity: "month", groupBy: "none" });
    expect(r.totals.paymentCount).toBe(10);
  });

  test("buckets by day in the business timezone, not UTC", async () => {
    const r = await getRevenueReport(t.db, { ...base, granularity: "day", groupBy: "none" });
    const byDay = new Map(r.series.map((s) => [s.period, s]));
    // b2 deposit is 22:00Z on 2 Nov = 09:00 on 3 Nov in Melbourne.
    expect(byDay.get("2026-11-02")?.grossCents).toBe(0);
    expect(byDay.get("2026-11-03")?.grossCents).toBe(4750 + 6250);
    expect(byDay.get("2026-11-12")).toMatchObject({
      grossCents: 0,
      refundsCents: 4750,
      netCents: -4750,
    });
    expect(r.series).toHaveLength(30);
  });

  test("weekly buckets start on Monday and zero fill gaps", async () => {
    const r = await getRevenueReport(t.db, { ...base, granularity: "week", groupBy: "none" });
    expect(r.series.map((s) => s.period)).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
    ]);
    const byWeek = new Map(r.series.map((s) => [s.period, s]));
    expect(byWeek.get("2026-10-26")?.grossCents).toBe(4750); // Sun 1 Nov belongs to the week of 26 Oct
    expect(byWeek.get("2026-11-02")?.grossCents).toBe(26750);
    expect(byWeek.get("2026-11-09")).toMatchObject({ grossCents: 11400, refundsCents: 4750 });
    expect(byWeek.get("2026-11-23")?.grossCents).toBe(0);
  });

  test("groups by location", async () => {
    const r = await getRevenueReport(t.db, { ...base, granularity: "month", groupBy: "location" });
    const south = r.rows.find((x) => x.groupName === "Southside");
    const north = r.rows.find((x) => x.groupName === "Northside");
    expect(south).toMatchObject({ groupId: fx.southside, grossCents: 12500, depositsCents: 6250 });
    expect(north).toMatchObject({
      groupId: fx.northside,
      grossCents: 30400,
      refundsCents: 4750,
      feesKeptCents: 11400,
    });
    expect(south!.grossCents + north!.grossCents).toBe(r.totals.grossCents);
  });

  test("groups by service, splitting multi-service bookings pro rata and exactly", async () => {
    const r = await getRevenueReport(t.db, { ...base, granularity: "month", groupBy: "service" });
    const beard = r.rows.find((x) => x.groupName === "Beard");
    const cut = r.rows.find((x) => x.groupName === "Cut");
    expect(beard?.grossCents).toBe(3000);
    expect(cut?.grossCents).toBe(39900);
    expect(r.rows.reduce((sum, x) => sum + x.grossCents, 0)).toBe(r.totals.grossCents);
    expect(r.rows.reduce((sum, x) => sum + x.refundsCents, 0)).toBe(r.totals.refundsCents);
  });

  test("ranges outside any payments are all zero", async () => {
    const r = await getRevenueReport(t.db, {
      timezone: TZ,
      from: "2025-01-01",
      to: "2025-01-31",
      granularity: "month",
      groupBy: "none",
    });
    expect(r.totals.grossCents).toBe(0);
    expect(r.series).toHaveLength(1);
  });

  test("rejects invalid ranges", async () => {
    await expect(
      getRevenueReport(t.db, { ...base, to: "2026-10-01", granularity: "day", groupBy: "none" }),
    ).rejects.toBeInstanceOf(ReportInputError);
    await expect(
      getRevenueReport(t.db, { ...base, from: "nope", granularity: "day", groupBy: "none" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      getRevenueReport(t.db, { ...base, from: "2026-02-30", granularity: "day", groupBy: "none" }),
    ).rejects.toThrow(/real calendar/);
    await expect(
      getRevenueReport(t.db, { ...base, from: "2020-01-01", granularity: "day", groupBy: "none" }),
    ).rejects.toThrow(/limited/);
  });
});
