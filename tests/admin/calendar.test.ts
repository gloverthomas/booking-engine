import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { createService, seedBasics } from "../helpers/factories";
import {
  auditLog,
  booking,
  bookingService,
  location,
  serviceLocation,
  timeBlock,
} from "@/db/schema";
import {
  createManualBlock,
  deleteBlock,
  listCalendarEvents,
  listCalendarResources,
} from "@/server/admin/calendar";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;

const range = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

async function addBooking(
  status: typeof booking.$inferInsert.status,
  start: string,
  end: string,
  overrides: Partial<typeof booking.$inferInsert> = {},
) {
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId: seed.stylist.id,
      locationId: seed.loc.id,
      clientId: seed.cl.id,
      status,
      during: range(start, end),
      totalCents: 9500,
      ...overrides,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterEach(async () => {
  await t.client.close();
});

describe("listCalendarEvents", () => {
  const week = { from: new Date("2026-11-15T00:00:00Z"), to: new Date("2026-11-22T00:00:00Z") };

  test("returns bookings with client name and service names, ordered by start", async () => {
    const svcA = await createService(t.db, seed.biz.id, { name: "Cut" });
    const svcB = await createService(t.db, seed.biz.id, { name: "Colour" });
    const later = await addBooking("confirmed", "2026-11-17T03:00:00Z", "2026-11-17T04:00:00Z");
    const earlier = await addBooking(
      "pending_payment",
      "2026-11-16T03:00:00Z",
      "2026-11-16T03:45:00Z",
    );
    await t.db.insert(bookingService).values([
      {
        bookingId: earlier.id,
        serviceId: svcB.id,
        name: "Colour",
        durationMin: 30,
        priceCents: 1,
        position: 1,
      },
      {
        bookingId: earlier.id,
        serviceId: svcA.id,
        name: "Cut",
        durationMin: 15,
        priceCents: 1,
        position: 0,
      },
    ]);

    const events = await listCalendarEvents(t.db, week);

    expect(events.map((e) => e.id)).toEqual([earlier.id, later.id]);
    expect(events[0]).toMatchObject({
      kind: "booking",
      status: "pending_payment",
      clientName: "Sam Client",
      services: ["Cut", "Colour"],
      start: "2026-11-16T03:00:00.000Z",
      end: "2026-11-16T03:45:00.000Z",
      totalCents: 9500,
    });
  });

  test("excludes cancelled, expired and late-cancelled bookings but keeps completed and no-shows", async () => {
    await addBooking("cancelled_by_client", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    await addBooking("cancelled_by_staff", "2026-11-16T05:00:00Z", "2026-11-16T06:00:00Z");
    await addBooking("expired", "2026-11-16T07:00:00Z", "2026-11-16T08:00:00Z");
    await addBooking("late_cancelled", "2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z");
    const done = await addBooking("completed", "2026-11-17T03:00:00Z", "2026-11-17T04:00:00Z");
    const ns = await addBooking("no_show", "2026-11-17T05:00:00Z", "2026-11-17T06:00:00Z");

    const events = await listCalendarEvents(t.db, week);
    expect(events.map((e) => e.id)).toEqual([done.id, ns.id]);
  });

  test("includes events overlapping the range edges but not those outside", async () => {
    const straddles = await addBooking("confirmed", "2026-11-14T23:30:00Z", "2026-11-15T00:30:00Z");
    await addBooking("confirmed", "2026-11-14T22:00:00Z", "2026-11-14T23:00:00Z");
    await addBooking("confirmed", "2026-11-22T00:00:00Z", "2026-11-22T01:00:00Z");

    const events = await listCalendarEvents(t.db, week);
    expect(events.map((e) => e.id)).toEqual([straddles.id]);
  });

  test("filters bookings by location and everything by staff", async () => {
    const [other] = await t.db
      .insert(location)
      .values({ businessId: seed.biz.id, name: "Southside" })
      .returning();
    const north = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    const south = await addBooking("confirmed", "2026-11-16T05:00:00Z", "2026-11-16T06:00:00Z", {
      locationId: other.id,
    });

    const onlySouth = await listCalendarEvents(t.db, week, other.id);
    expect(onlySouth.map((e) => e.id)).toEqual([south.id]);

    const wrongStaff = await listCalendarEvents(t.db, week, undefined, crypto.randomUUID());
    expect(wrongStaff).toEqual([]);
    const rightStaff = await listCalendarEvents(t.db, week, undefined, seed.stylist.id);
    expect(rightStaff.map((e) => e.id)).toEqual([north.id, south.id]);
  });

  test("shows manual blocks and muted external Google busy time", async () => {
    await t.db.insert(timeBlock).values([
      {
        staffId: seed.stylist.id,
        during: range("2026-11-16T01:00:00Z", "2026-11-16T02:00:00Z"),
        reason: "Dentist",
        source: "manual",
      },
      {
        staffId: seed.stylist.id,
        during: range("2026-11-16T05:00:00Z", "2026-11-16T06:00:00Z"),
        source: "google",
        externalId: "g1",
      },
    ]);

    const events = await listCalendarEvents(t.db, week);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "block", reason: "Dentist" });
    expect(events[1]).toMatchObject({ kind: "external", reason: null });
  });
});

describe("listCalendarResources", () => {
  test("returns active locations, staff and services with location offerings", async () => {
    const svc = await createService(t.db, seed.biz.id, { name: "Cut", sortOrder: 1 });
    await createService(t.db, seed.biz.id, { name: "Hidden", active: false });
    await t.db.insert(serviceLocation).values({ serviceId: svc.id, locationId: seed.loc.id });
    await t.db.insert(location).values({ businessId: seed.biz.id, name: "Closed", active: false });

    const res = await listCalendarResources(t.db);

    expect(res.timezone).toBe("Australia/Melbourne");
    expect(res.slotStepMin).toBe(15);
    expect(res.locations.map((l) => l.name)).toEqual(["Northside"]);
    expect(res.staff.map((s) => s.name)).toEqual(["Ryan"]);
    expect(res.services).toEqual([
      { id: svc.id, name: "Cut", durationMin: 45, priceCents: 9500, locationIds: [seed.loc.id] },
    ]);
  });
});

describe("manual blocks", () => {
  const actor = "owner:u1" as const;

  test("creates a block, audits it and reports overlapping bookings", async () => {
    await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");

    const result = await createManualBlock(
      t.db,
      {
        staffId: seed.stylist.id,
        start: new Date("2026-11-16T02:30:00Z"),
        end: new Date("2026-11-16T03:30:00Z"),
        reason: "Lunch",
      },
      actor,
    );

    expect(result.overlappingBookings).toBe(1);
    const [row] = await t.db.select().from(timeBlock);
    expect(row).toMatchObject({ reason: "Lunch", source: "manual" });
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ actor, action: "time_block.created", entityId: row.id });
  });

  test("rejects an empty or reversed range", async () => {
    const t0 = new Date("2026-11-16T02:30:00Z");
    await expect(
      createManualBlock(t.db, { staffId: seed.stylist.id, start: t0, end: t0 }, actor),
    ).rejects.toThrow(/after the start/i);
  });

  test("deletes a manual block and audits it", async () => {
    const created = await createManualBlock(
      t.db,
      {
        staffId: seed.stylist.id,
        start: new Date("2026-11-16T02:30:00Z"),
        end: new Date("2026-11-16T03:30:00Z"),
      },
      actor,
    );
    await deleteBlock(t.db, created.blockId, actor);
    expect(await t.db.select().from(timeBlock)).toHaveLength(0);
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(["time_block.created", "time_block.deleted"]);
  });

  test("refuses to delete imported Google busy time or an unknown block", async () => {
    const [google] = await t.db
      .insert(timeBlock)
      .values({
        staffId: seed.stylist.id,
        during: range("2026-11-16T05:00:00Z", "2026-11-16T06:00:00Z"),
        source: "google",
        externalId: "g1",
      })
      .returning();
    await expect(deleteBlock(t.db, google.id, actor)).rejects.toThrow(/Google/);
    await expect(deleteBlock(t.db, crypto.randomUUID(), actor)).rejects.toThrow(/not found/i);
    expect(await t.db.select().from(timeBlock)).toHaveLength(1);
  });
});
