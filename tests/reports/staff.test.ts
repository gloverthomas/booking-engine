import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  availabilityRule,
  booking,
  bookingService,
  payment,
  rosterException,
  staff,
} from "@/db/schema";
import { getBookingsReport } from "@/server/reports/bookings";
import { getCancellationsReport } from "@/server/reports/cancellations";
import { getRevenueReport } from "@/server/reports/revenue";
import {
  ReportAccessError,
  reportScopeFor,
  requireAllScope,
  scopedStaffId,
  type ReportScope,
} from "@/server/reports/scope";
import { buildReportTable, REPORT_TABLE_IDS, tableToCsv } from "@/server/reports/tables";
import { createTestDb } from "../helpers/test-db";
import "./timeouts";
import { NOW, seedReportFixture, TZ, type Fixture } from "./fixture";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let fx: Fixture;
let alexId: string;
const nov = { timezone: TZ, from: "2026-11-01", to: "2026-11-30" };

beforeAll(async () => {
  t = await createTestDb();
  fx = await seedReportFixture(t.db);
  const [alex] = await t.db
    .insert(staff)
    .values({ businessId: fx.businessId, name: "Alex Stylist", role: "stylist" })
    .returning();
  alexId = alex.id;
  // Alex works Tuesdays 09:00 to 13:00 at Northside, but is off on Tue 24 Nov.
  await t.db.insert(availabilityRule).values({
    staffId: alexId,
    locationId: fx.northside,
    weekday: 2,
    startMinute: 540,
    endMinute: 780,
  });
  await t.db.insert(rosterException).values({ staffId: alexId, date: "2026-11-24", kind: "off" });
  const mk = async (
    status: "completed" | "no_show",
    start: string,
    end: string,
    clientId: string,
  ) => {
    const [row] = await t.db
      .insert(booking)
      .values({
        staffId: alexId,
        locationId: fx.northside,
        clientId,
        status,
        during: { start: new Date(start), end: new Date(end) },
        totalCents: 6000,
        depositCents: 3000,
      })
      .returning();
    await t.db.insert(bookingService).values({
      bookingId: row.id,
      serviceId: fx.cutId,
      name: "Cut",
      durationMin: 60,
      priceCents: 6000,
    });
    return row.id;
  };
  // Tue 10 Nov 10:00 to 11:00 local, completed, paid in full on the day.
  const done = await mk(
    "completed",
    "2026-11-09T23:00:00Z",
    "2026-11-10T00:00:00Z",
    fx.clients.sam,
  );
  await t.db.insert(payment).values([
    {
      bookingId: done,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents: 3000,
      createdAt: new Date("2026-11-10T01:00:00Z"),
    },
    {
      bookingId: done,
      kind: "balance",
      method: "cash",
      status: "succeeded",
      amountCents: 3000,
      createdAt: new Date("2026-11-10T02:00:00Z"),
    },
  ]);
  // Wed 11 Nov 11:00 local, no-show; deposit kept.
  const missed = await mk("no_show", "2026-11-11T00:00:00Z", "2026-11-11T01:00:00Z", fx.clients.jo);
  await t.db.insert(payment).values({
    bookingId: missed,
    kind: "deposit",
    method: "stripe_online",
    status: "succeeded",
    amountCents: 3000,
    createdAt: new Date("2026-11-05T01:00:00Z"),
  });
});
afterAll(async () => {
  await t.client.close();
});

describe("revenue per stylist", () => {
  test("groupBy staff splits cash received by the booking's stylist", async () => {
    const r = await getRevenueReport(t.db, { ...nov, granularity: "month", groupBy: "staff" });
    const net = (name: string) =>
      r.rows.filter((row) => row.groupName === name).reduce((s, row) => s + row.netCents, 0);
    expect(net("Alex Stylist")).toBe(9000); // 3000 + 3000 + the no-show deposit 3000
    expect(net("Ryan")).toBe(r.totals.netCents - 9000);
  });

  test("the staffId filter limits totals to one stylist", async () => {
    const all = await getRevenueReport(t.db, { ...nov, granularity: "month", groupBy: "none" });
    const alex = await getRevenueReport(t.db, {
      ...nov,
      granularity: "month",
      groupBy: "none",
      staffId: alexId,
    });
    expect(alex.totals).toMatchObject({
      grossCents: 9000,
      netCents: 9000,
      depositsCents: 6000,
      balancesCents: 3000,
    });
    // 3000 of Alex's deposits are on a no-show, so they are forfeited.
    expect(alex.totals.forfeitedDepositsCents).toBe(3000);
    expect(all.totals.netCents).toBeGreaterThan(alex.totals.netCents);
  });
});

describe("bookings and utilisation per stylist", () => {
  test("the staffId filter limits counts and rostered hours, and roster exceptions remove days", async () => {
    const r = await getBookingsReport(t.db, { ...nov, staffId: alexId, groupBy: "staff" });
    expect(r.bookedCount).toBe(1);
    expect(r.bookedHours).toBe(1);
    // Tuesdays 3, 10, 17 (the 24th is off): 3 x 4h.
    expect(r.availableHours).toBe(12);
    expect(r.utilisationPct).toBe(8.3);
    expect(r.byStaff).toEqual([
      {
        staffId: alexId,
        staffName: "Alex Stylist",
        bookings: 1,
        bookedHours: 1,
        availableHours: 12,
        utilisationPct: 8.3,
      },
    ]);
  });

  test("byStaff has one row per stylist and is empty unless asked for", async () => {
    const r = await getBookingsReport(t.db, { ...nov, groupBy: "staff" });
    expect(r.byStaff.map((s) => s.staffName)).toEqual(["Alex Stylist", "Ryan"]);
    const ryan = r.byStaff.find((s) => s.staffName === "Ryan");
    expect(ryan).toMatchObject({ bookings: 4, availableHours: 188 });
    expect((await getBookingsReport(t.db, nov)).byStaff).toEqual([]);
  });

  test("the unfiltered totals still add up across stylists", async () => {
    const r = await getBookingsReport(t.db, { ...nov, groupBy: "staff" });
    expect(r.bookedCount).toBe(5);
    expect(r.availableHours).toBe(188 + 12);
  });
});

describe("cancellations per stylist", () => {
  test("filter and groupBy staff", async () => {
    const r = await getCancellationsReport(t.db, { ...nov, staffId: alexId, groupBy: "staff" });
    expect(r.counts.no_show).toBe(1);
    expect(r.scheduledCount).toBe(2);
    expect(r.cancellationRatePct).toBe(50);
    expect(r.rows[0].staffName).toBe("Alex Stylist");
    expect(r.byStaff).toEqual([
      {
        staffId: alexId,
        staffName: "Alex Stylist",
        scheduledCount: 2,
        cancelled: 0,
        lateCancelled: 0,
        noShows: 1,
        cancellationRatePct: 50,
        keptCents: 3000,
        refundedCents: 0,
      },
    ]);
  });

  test("all stylists: ryan's rows are separate from alex's", async () => {
    const r = await getCancellationsReport(t.db, { ...nov, groupBy: "staff" });
    expect(r.byStaff.map((s) => s.staffName)).toEqual(["Alex Stylist", "Ryan"]);
    expect(r.counts.total).toBe(4);
    expect((await getCancellationsReport(t.db, nov)).byStaff).toEqual([]);
  });
});

describe("role scoping on the server", () => {
  test("scope is derived from the role, not the URL", () => {
    expect(reportScopeFor("owner", null)).toEqual({ kind: "all" });
    expect(reportScopeFor("manager", "m")).toEqual({ kind: "all" });
    expect(reportScopeFor("stylist", "s")).toEqual({ kind: "own", staffId: "s" });
    expect(reportScopeFor("stylist", null)).toEqual({ kind: "none" });
    expect(reportScopeFor("reception", "r")).toEqual({ kind: "none" });
  });

  test("an own-only scope always wins over a requested staff id", () => {
    expect(scopedStaffId({ kind: "own", staffId: "me" }, "someone-else")).toBe("me");
    expect(scopedStaffId({ kind: "all" }, "x")).toBe("x");
    expect(scopedStaffId({ kind: "all" })).toBeUndefined();
    expect(() => scopedStaffId({ kind: "none" })).toThrow(ReportAccessError);
    expect(() => requireAllScope({ kind: "own", staffId: "me" })).toThrow(ReportAccessError);
    expect(() => requireAllScope({ kind: "all" })).not.toThrow();
  });

  const ctx = (query: Record<string, string>, scope: ReportScope) => ({
    timezone: TZ,
    now: NOW,
    query: { from: "2026-11-01", to: "2026-11-30", ...query },
    scope,
  });

  test("a stylist cannot read another stylist's numbers by changing the query string", async () => {
    const alexScope = { kind: "own", staffId: alexId } as const;
    const attacks: Array<Record<string, string>> = [
      { staff: fx.staffId },
      { staff: fx.staffId, groupBy: "staff" },
      { groupBy: "location" },
    ];
    for (const attack of attacks) {
      const revenue = await buildReportTable(t.db, "revenue", ctx(attack, alexScope));
      const total = (revenue.rows as Array<{ netCents: number }>).reduce(
        (s, r) => s + r.netCents,
        0,
      );
      expect(total).toBe(9000);
      const util = await buildReportTable(t.db, "utilisation-by-staff", ctx(attack, alexScope));
      expect((util.rows as Array<{ staffName: string }>).map((r) => r.staffName)).toEqual([
        "Alex Stylist",
      ]);
      const cancels = await buildReportTable(t.db, "cancellations", ctx(attack, alexScope));
      expect(
        (cancels.rows as Array<{ staffName: string }>).every((r) => r.staffName === "Alex Stylist"),
      ).toBe(true);
    }
  });

  test("everyone-scope can filter to one stylist or split by stylist", async () => {
    const filtered = await buildReportTable(
      t.db,
      "revenue",
      ctx({ staff: alexId }, { kind: "all" }),
    );
    expect((filtered.rows as Array<{ netCents: number }>).reduce((s, r) => s + r.netCents, 0)).toBe(
      9000,
    );
    const split = await buildReportTable(
      t.db,
      "revenue",
      ctx({ groupBy: "staff", granularity: "month" }, { kind: "all" }),
    );
    expect(split.columns.map((c) => c.header)).toContain("Stylist");
    expect(new Set((split.rows as Array<{ group: string }>).map((r) => r.group))).toEqual(
      new Set(["Alex Stylist", "Ryan"]),
    );
  });

  test("business-wide tables are refused for own-only and no scope", async () => {
    for (const id of ["top-clients", "lapsed-clients", "outstanding"] as const) {
      await expect(
        buildReportTable(t.db, id, ctx({}, { kind: "own", staffId: alexId })),
      ).rejects.toBeInstanceOf(ReportAccessError);
      await expect(buildReportTable(t.db, id, ctx({}, { kind: "none" }))).rejects.toBeInstanceOf(
        ReportAccessError,
      );
      await expect(buildReportTable(t.db, id, ctx({}, { kind: "all" }))).resolves.toBeDefined();
    }
  });

  test("a scope of none cannot build any stylist table", async () => {
    await expect(
      buildReportTable(t.db, "revenue", ctx({}, { kind: "none" })),
    ).rejects.toBeInstanceOf(ReportAccessError);
  });

  test("every table builds for an own-only scope or is refused, never leaks", async () => {
    for (const id of REPORT_TABLE_IDS) {
      const table = await buildReportTable(
        t.db,
        id,
        ctx({}, { kind: "own", staffId: alexId }),
      ).catch((e: unknown) => e);
      if (table instanceof ReportAccessError) continue;
      expect(tableToCsv(table as Awaited<ReturnType<typeof buildReportTable>>)).not.toContain(
        "Ryan",
      );
    }
  });
});
