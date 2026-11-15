import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bookingService, serviceLevelPrice, staff } from "@/db/schema";
import { createHold, expireHolds } from "@/server/booking";
import {
  NOW,
  addBooking,
  addStaff,
  createWorld,
  offer,
  openEveryDay,
  type World,
} from "../availability/setup";
import { bookingRow, eventsOfType, hold, holdInput, local, opts } from "./setup";

const minutesFrom = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

let w: World;

beforeEach(async () => {
  w = await createWorld({ minNoticeMin: 0 });
});

afterEach(async () => {
  await w.t.client.close();
});

describe("createHold: staffRequested", () => {
  test("stores true when the client chose the stylist", async () => {
    const result = await hold(w, { staffRequested: true });
    expect((await bookingRow(w.db, result.bookingId)).staffRequested).toBe(true);
  });

  test("defaults to false (first available or staff-made)", async () => {
    const result = await hold(w);
    expect((await bookingRow(w.db, result.bookingId)).staffRequested).toBe(false);
  });

  test("rejects a non-boolean value", async () => {
    await expect(
      createHold(w.db, { ...holdInput(w), staffRequested: "yes" as unknown as boolean }, opts),
    ).rejects.toThrow("Invalid booking request");
  });
});

describe("createHold: first available with several stylists", () => {
  test("assigns the free stylist with the fewest bookings that day and prices for their level", async () => {
    const amy = await addStaff(w.db, w.businessId, "Amy");
    await offer(w.db, w.haircutId, w.locationId, amy.id);
    await openEveryDay(w.db, amy.id, w.locationId);
    await w.db.update(staff).set({ level: 3 }).where(eq(staff.id, amy.id));
    await w.db.update(staff).set({ level: 1 }).where(eq(staff.id, w.staffId));
    await w.db.insert(serviceLevelPrice).values([
      { serviceId: w.haircutId, level: 3, priceCents: 15000 },
      { serviceId: w.haircutId, level: 1, priceCents: 8000 },
    ]);
    // Amy has a booking earlier that day, so Ryan is preferred even though "Amy" sorts first
    await addBooking(
      w.db,
      { ...w, staffId: amy.id },
      local("2026-11-02T09:00"),
      local("2026-11-02T09:45"),
    );

    const result = await hold(w, { staffId: undefined });
    const row = await bookingRow(w.db, result.bookingId);
    expect(row.staffId).toBe(w.staffId);
    expect(row.staffRequested).toBe(false);
    expect(result.totalCents).toBe(8000);
    const lines = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, result.bookingId));
    expect(lines.map((l) => l.priceCents)).toEqual([8000]);
  });

  test("breaks ties alphabetically and prices for that stylist's level", async () => {
    const amy = await addStaff(w.db, w.businessId, "Amy");
    await offer(w.db, w.haircutId, w.locationId, amy.id);
    await openEveryDay(w.db, amy.id, w.locationId);
    await w.db.update(staff).set({ level: 3 }).where(eq(staff.id, amy.id));
    await w.db
      .insert(serviceLevelPrice)
      .values({ serviceId: w.haircutId, level: 3, priceCents: 15000 });

    const result = await hold(w, { staffId: undefined });
    expect((await bookingRow(w.db, result.bookingId)).staffId).toBe(amy.id);
    expect(result.totalCents).toBe(15000);
    expect(result.depositCents).toBeGreaterThan(0);
  });

  test("a requested stylist is honoured even when another has fewer bookings", async () => {
    const amy = await addStaff(w.db, w.businessId, "Amy");
    await offer(w.db, w.haircutId, w.locationId, amy.id);
    await openEveryDay(w.db, amy.id, w.locationId);
    const result = await hold(w, { staffId: w.staffId, staffRequested: true });
    const row = await bookingRow(w.db, result.bookingId);
    expect(row.staffId).toBe(w.staffId);
    expect(row.staffRequested).toBe(true);
  });
});

describe("expireHolds emits booking.expired", () => {
  test("one event per expired hold, committed with the status change", async () => {
    const first = await hold(w);
    const second = await hold(w, { start: local("2026-11-02T14:00") });
    const live = await hold(w, { start: local("2026-11-02T16:00"), now: minutesFrom(8) });

    expect(await expireHolds(w.db, minutesFrom(11))).toBe(2);

    const events = await eventsOfType(w.db, "booking.expired");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => (e as { bookingId: string }).bookingId))).toEqual(
      new Set([first.bookingId, second.bookingId]),
    );
    expect((await bookingRow(w.db, live.bookingId)).status).toBe("pending_payment");
  });

  test("is idempotent: expiring again emits nothing more", async () => {
    await hold(w);
    await expireHolds(w.db, minutesFrom(11));
    await expireHolds(w.db, minutesFrom(12));
    expect(await eventsOfType(w.db, "booking.expired")).toHaveLength(1);
  });

  test("a hold swept while someone books the slot still emits its event", async () => {
    const lapsed = await hold(w);
    await hold(w, {
      client: { firstName: "B", lastName: "C", email: "b@example.com", phone: "0433 111 222" },
      now: minutesFrom(12),
    });
    const events = await eventsOfType(w.db, "booking.expired");
    expect(events).toEqual([{ bookingId: lapsed.bookingId }]);
  });
});
