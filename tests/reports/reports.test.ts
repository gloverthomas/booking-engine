import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import "./timeouts";
import { seedBasics } from "../helpers/factories";
import { availabilityRule, booking, client } from "@/db/schema";
import { getBookingsReport } from "@/server/reports/bookings";
import { getCancellationsReport } from "@/server/reports/cancellations";
import { getClientsReport } from "@/server/reports/clients";
import { getOutstandingReport } from "@/server/reports/outstanding";
import { NOW, seedReportFixture, TZ, type Fixture } from "./fixture";

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

const nov = { timezone: TZ, from: "2026-11-01", to: "2026-11-30" };

describe("getBookingsReport", () => {
  test("counts every status and only honoured appointments as booked", async () => {
    const r = await getBookingsReport(t.db, nov);
    expect(r.statusCounts).toMatchObject({
      completed: 3,
      confirmed: 1,
      late_cancelled: 1,
      no_show: 1,
      cancelled_by_client: 1,
      pending_payment: 1,
      expired: 0,
    });
    expect(r.bookedCount).toBe(4);
    expect(r.bookedHours).toBe(3.33);
  });

  test("utilisation = booked hours / (weekly hours minus time blocks)", async () => {
    const r = await getBookingsReport(t.db, nov);
    // Northside: 21 weekdays x 8h minus the 4h dentist block. Southside: 4 Saturdays x 6h.
    expect(r.availableHours).toBe(188);
    expect(r.utilisationPct).toBe(1.8);
    const north = r.byLocation.find((l) => l.locationName === "Northside");
    const south = r.byLocation.find((l) => l.locationName === "Southside");
    expect(north).toMatchObject({ bookings: 3, bookedHours: 2.25, availableHours: 164 });
    expect(south).toMatchObject({
      bookings: 1,
      bookedHours: 1.08,
      availableHours: 24,
      utilisationPct: 4.5,
    });
  });

  test("busiest days and times, with days bucketed in local time", async () => {
    const r = await getBookingsReport(t.db, nov);
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay.find((d) => d.date === "2026-11-03")).toMatchObject({
      bookings: 1,
      bookedHours: 0.75,
    });
    expect(r.byDay.find((d) => d.date === "2026-11-02")?.bookings).toBe(0);
    const busy = (label: string) => r.byWeekday.find((w) => w.label === label)?.bookings;
    expect([busy("Mon"), busy("Tue"), busy("Fri"), busy("Sat"), busy("Wed")]).toEqual([
      1, 1, 1, 1, 0,
    ]);
    expect(r.byHour.map((h) => h.hour)).toEqual([9, 10, 15, 16]);
    expect(r.byHour[0].label).toBe("9 am");
  });

  test("open ended rules with nothing booked give 0% utilisation", async () => {
    const r = await getBookingsReport(t.db, { timezone: TZ, from: "2025-01-01", to: "2025-01-07" });
    // Rules are open ended so there are still available hours, but nothing booked.
    expect(r.bookedCount).toBe(0);
    expect(r.utilisationPct).toBe(0);
  });
});

describe("available hours edge cases", () => {
  test("respects valid_from/valid_to and DST day length", async () => {
    const own = await createTestDb();
    const { loc, stylist } = await seedBasics(own.db);
    await own.db.insert(availabilityRule).values([
      // Sundays only, whole day, valid for a window: 15 Nov and 22 Nov count; 8 Nov and 29 Nov do not.
      {
        staffId: stylist.id,
        locationId: loc.id,
        weekday: 0,
        startMinute: 0,
        endMinute: 1440,
        validFrom: "2026-11-15",
        validTo: "2026-11-22",
      },
    ]);
    const windowed = await getBookingsReport(own.db, {
      timezone: TZ,
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(windowed.availableHours).toBe(48);
    expect(windowed.utilisationPct).toBe(0);

    await own.db.insert(availabilityRule).values({
      staffId: stylist.id,
      locationId: loc.id,
      weekday: 0,
      startMinute: 0,
      endMinute: 1440,
      validFrom: "2026-10-04",
      validTo: "2026-10-04",
    });
    // Sunday 4 Oct 2026: clocks go forward, the day is 23 hours long.
    const dst = await getBookingsReport(own.db, {
      timezone: TZ,
      from: "2026-10-04",
      to: "2026-10-04",
    });
    expect(dst.availableHours).toBe(23);
    // Sunday 5 Apr 2026: clocks go back, 25 hours.
    await own.db.insert(availabilityRule).values({
      staffId: stylist.id,
      locationId: loc.id,
      weekday: 0,
      startMinute: 0,
      endMinute: 1440,
      validFrom: "2026-04-05",
      validTo: "2026-04-05",
    });
    const back = await getBookingsReport(own.db, {
      timezone: TZ,
      from: "2026-04-05",
      to: "2026-04-05",
    });
    expect(back.availableHours).toBe(25);
    await own.client.close();
  });
});

describe("getCancellationsReport", () => {
  test("counts by type and totals the dollars kept", async () => {
    const r = await getCancellationsReport(t.db, nov);
    expect(r.counts).toEqual({
      cancelled_by_client: 1,
      cancelled_by_staff: 0,
      late_cancelled: 1,
      no_show: 1,
      total: 3,
    });
    expect(r.scheduledCount).toBe(7);
    expect(r.cancellationRatePct).toBe(42.9);
    expect(r.keptCents).toBe(11400);
    expect(r.refundedCents).toBe(4750);
  });

  test("rows show what each booking kept, newest first", async () => {
    const r = await getCancellationsReport(t.db, nov);
    expect(r.rows.map((x) => x.bookingId)).toEqual([
      fx.bookings.b5,
      fx.bookings.b4,
      fx.bookings.b3,
    ]);
    const [b5, b4, b3] = r.rows;
    expect(b5).toMatchObject({ status: "cancelled_by_client", keptCents: 0, refundedCents: 4750 });
    expect(b4).toMatchObject({
      status: "no_show",
      depositPaidCents: 4750,
      feeChargedCents: 1900,
      keptCents: 6650,
    });
    expect(b3).toMatchObject({ status: "late_cancelled", keptCents: 4750, clientName: "Jo Chen" });
  });

  test("empty ranges give a null rate and no rows", async () => {
    const r = await getCancellationsReport(t.db, {
      timezone: TZ,
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(r.rows).toEqual([]);
    expect(r.cancellationRatePct).toBeNull();
  });
});

describe("getClientsReport", () => {
  test("splits new from returning clients", async () => {
    const r = await getClientsReport(t.db, { ...nov, now: NOW });
    expect(r).toMatchObject({ activeClients: 3, newClients: 2, returningClients: 1 });
    const oct = await getClientsReport(t.db, {
      timezone: TZ,
      from: "2026-10-01",
      to: "2026-10-31",
      now: NOW,
    });
    expect(oct).toMatchObject({ activeClients: 1, newClients: 1, returningClients: 0 });
  });

  test("rebook rate only counts visits whose window has elapsed", async () => {
    const early = await getClientsReport(t.db, { ...nov, now: NOW });
    expect(early.rebook).toMatchObject({ windowDays: 28, eligibleVisits: 0, ratePct: null });

    const later = await getClientsReport(t.db, { ...nov, now: new Date("2027-01-01T00:00:00Z") });
    // b1, b2, b9 are eligible; only b9's client (Jo) came back (b7, 11 days later).
    expect(later.rebook).toMatchObject({ eligibleVisits: 3, rebookedVisits: 1, ratePct: 33.3 });

    const octLater = await getClientsReport(t.db, {
      timezone: TZ,
      from: "2026-10-01",
      to: "2026-10-31",
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(octLater.rebook).toMatchObject({ eligibleVisits: 1, rebookedVisits: 1, ratePct: 100 });

    const tight = await getClientsReport(t.db, {
      timezone: TZ,
      from: "2026-10-01",
      to: "2026-10-31",
      now: new Date("2027-01-01T00:00:00Z"),
      rebookWindowDays: 7,
    });
    expect(tight.rebook).toMatchObject({ eligibleVisits: 1, rebookedVisits: 0, ratePct: 0 });
  });

  test("top clients are ranked by net money received", async () => {
    const r = await getClientsReport(t.db, { ...nov, now: NOW });
    expect(r.topClients.map((c) => [c.name, c.spendCents, c.visits])).toEqual([
      ["Alex Brown", 19150, 1],
      ["Jo Chen", 14250, 2],
      ["Sam Client", 4750, 1],
    ]);
    expect(r.topClients[0].lastVisit?.toISOString()).toBe("2026-11-06T22:00:00.000Z");
    const one = await getClientsReport(t.db, { ...nov, now: NOW, topLimit: 1 });
    expect(one.topClients).toHaveLength(1);
  });

  test("lapsed clients: no recent visit and nothing booked ahead", async () => {
    const r = await getClientsReport(t.db, { ...nov, now: NOW });
    expect(r.lapsed.total).toBe(1);
    expect(r.lapsed.rows[0]).toMatchObject({
      clientId: fx.clients.pat,
      name: "Pat Dunn",
      daysSinceLastVisit: 101,
      lifetimeVisits: 1,
    });
    // Jo has b7 booked ahead so is never lapsed; Sam and Alex lapse on a tight threshold.
    const tight = await getClientsReport(t.db, { ...nov, now: NOW, lapsedDays: 5 });
    expect(tight.lapsed.rows.map((c) => c.name).sort()).toEqual([
      "Alex Brown",
      "Pat Dunn",
      "Sam Client",
    ]);
    const limited = await getClientsReport(t.db, {
      ...nov,
      now: NOW,
      lapsedDays: 5,
      lapsedLimit: 2,
    });
    expect(limited.lapsed).toMatchObject({ total: 3 });
    expect(limited.lapsed.rows).toHaveLength(2);
  });

  test("merged duplicates roll up into the surviving client and never appear as lapsed", async () => {
    const own = await createTestDb();
    const { biz, loc, stylist, cl } = await seedBasics(own.db);
    const [dup] = await own.db
      .insert(client)
      .values({ businessId: biz.id, firstName: "Sammy", lastName: "Dup", mergedIntoId: cl.id })
      .returning();
    const visit = (clientId: string, start: string, end: string) =>
      own.db.insert(booking).values({
        staffId: stylist.id,
        locationId: loc.id,
        clientId,
        status: "completed",
        during: { start: new Date(start), end: new Date(end) },
      });
    await visit(dup.id, "2026-10-02T00:00:00Z", "2026-10-02T00:45:00Z");
    await visit(cl.id, "2026-11-03T00:00:00Z", "2026-11-03T00:45:00Z");
    const r = await getClientsReport(own.db, { ...nov, now: NOW });
    // One person, whose first visit was the duplicate's in October: returning, not new.
    expect(r).toMatchObject({ activeClients: 1, newClients: 0, returningClients: 1 });
    const lapsed = await getClientsReport(own.db, { ...nov, now: NOW, lapsedDays: 5 });
    expect(lapsed.lapsed.rows.map((c) => c.name)).toEqual(["Sam Client"]);
    await own.client.close();
  });
});

describe("getOutstandingReport", () => {
  test("splits overdue balances from upcoming ones", async () => {
    const r = await getOutstandingReport(t.db, { now: NOW });
    expect(r).toMatchObject({
      overdueCents: 4750,
      overdueCount: 1,
      upcomingCents: 4750,
      upcomingCount: 1,
    });
    const [overdue, upcoming] = r.rows;
    expect(overdue).toMatchObject({
      bookingId: fx.bookings.b9,
      state: "overdue",
      status: "completed",
      clientName: "Jo Chen",
      totalCents: 9500,
      paidCents: 4750,
      outstandingCents: 4750,
    });
    expect(upcoming).toMatchObject({ bookingId: fx.bookings.b7, state: "upcoming" });
  });

  test("a confirmed booking in the past that was never completed counts as overdue", async () => {
    const r = await getOutstandingReport(t.db, { now: new Date("2026-11-25T00:00:00Z"), limit: 1 });
    expect(r.overdueCount).toBe(2);
    expect(r.overdueCents).toBe(9500);
    expect(r.rows).toHaveLength(1);
  });

  test("uses the system clock when none is given", async () => {
    const r = await getOutstandingReport(t.db);
    expect(r.overdueCount).toBeGreaterThanOrEqual(1);
  });
});
