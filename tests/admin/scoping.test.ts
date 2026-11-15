import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { createStaff, seedBasics } from "../helpers/factories";
import { booking, bookingService, client, staff, timeBlock } from "@/db/schema";
import type { AccessContext } from "@/server/admin/access";
import { getBookingDetail, getCheckoutView, listBookings } from "@/server/admin/bookings";
import {
  createManualBlock,
  deleteBlock,
  listCalendarEvents,
  listCalendarResources,
} from "@/server/admin/calendar";
import { getClientProfile, searchClients, updateClientNotes } from "@/server/admin/clients";
import { STAFF_PALETTE } from "@/server/admin/staff-colour";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let alex: typeof staff.$inferSelect;
let blake: typeof staff.$inferSelect;
let alexBooking: typeof booking.$inferSelect;
let blakeBooking: typeof booking.$inferSelect;

const NOW = new Date("2026-11-14T00:00:00Z");
const week = { from: new Date("2026-11-15T00:00:00Z"), to: new Date("2026-11-22T00:00:00Z") };

const OWNER: AccessContext = { role: "owner", staffId: null };
const asAlex = (): AccessContext => ({ role: "stylist", staffId: alex.id });
const MANAGER: AccessContext = { role: "manager", staffId: null };
const RECEPTION: AccessContext = { role: "reception", staffId: null };

async function addBooking(staffId: string, start: string, end: string, clientId = seed.cl.id) {
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId,
      locationId: seed.loc.id,
      clientId,
      status: "confirmed",
      during: { start: new Date(start), end: new Date(end) },
      totalCents: 9500,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
  alex = await createStaff(t.db, seed.biz.id, { name: "Alex", email: "alex@example.com" });
  blake = await createStaff(t.db, seed.biz.id, { name: "Blake", email: "blake@example.com" });
  alexBooking = await addBooking(alex.id, "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
  blakeBooking = await addBooking(blake.id, "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
});
afterEach(async () => {
  await t.client.close();
});

describe("calendar events", () => {
  test("a stylist only gets their own bookings", async () => {
    const events = await listCalendarEvents(t.db, week, asAlex());
    expect(events.map((e) => e.id)).toEqual([alexBooking.id]);
  });

  test("asking for a colleague's column returns nothing, never their bookings", async () => {
    const events = await listCalendarEvents(t.db, week, asAlex(), { staffIds: [blake.id] });
    expect(events).toEqual([]);
    const both = await listCalendarEvents(t.db, week, asAlex(), { staffIds: [blake.id, alex.id] });
    expect(both.map((e) => e.id)).toEqual([alexBooking.id]);
  });

  test("a stylist only gets their own blocks and Google busy time", async () => {
    await t.db.insert(timeBlock).values([
      {
        staffId: alex.id,
        during: { start: new Date("2026-11-16T05:00:00Z"), end: new Date("2026-11-16T06:00:00Z") },
        reason: "Mine",
        source: "manual",
      },
      {
        staffId: blake.id,
        during: { start: new Date("2026-11-16T05:00:00Z"), end: new Date("2026-11-16T06:00:00Z") },
        reason: "Theirs",
        source: "manual",
      },
      {
        staffId: blake.id,
        during: { start: new Date("2026-11-16T07:00:00Z"), end: new Date("2026-11-16T08:00:00Z") },
        source: "google",
        externalId: "g-blake",
      },
    ]);
    const events = await listCalendarEvents(t.db, week, asAlex());
    expect(events.filter((e) => e.kind !== "booking").map((e) => e.reason)).toEqual(["Mine"]);
  });

  test("roles that see everyone get every stylist, and can filter to some", async () => {
    for (const who of [OWNER, MANAGER, RECEPTION]) {
      const all = await listCalendarEvents(t.db, week, who);
      expect(all.map((e) => e.id).sort()).toEqual([alexBooking.id, blakeBooking.id].sort());
    }
    const onlyBlake = await listCalendarEvents(t.db, week, MANAGER, { staffIds: [blake.id] });
    expect(onlyBlake.map((e) => e.id)).toEqual([blakeBooking.id]);
  });

  test("a stylist with no staff profile is refused rather than shown everything", async () => {
    await expect(
      listCalendarEvents(t.db, week, { role: "stylist", staffId: null }),
    ).rejects.toThrow(/not linked to a staff profile/i);
  });
});

describe("calendar resources", () => {
  test("a stylist only sees themselves, with capabilities that hide manager tools", async () => {
    const res = await listCalendarResources(t.db, asAlex());
    expect(res.staff.map((s) => s.name)).toEqual(["Alex"]);
    expect(res.viewer).toMatchObject({
      seesAll: false,
      refund: false,
      reassign: false,
      mergeClients: false,
      createBookings: true,
      checkout: true,
    });
  });

  test("everyone else sees all active stylists, each with a colour", async () => {
    await t.db.update(staff).set({ active: false }).where(eq(staff.id, blake.id));
    await t.db.update(staff).set({ colour: "#abcdef" }).where(eq(staff.id, alex.id));
    const res = await listCalendarResources(t.db, OWNER);
    expect(res.staff.map((s) => s.name)).toEqual(["Alex", "Ryan"]);
    const byName = Object.fromEntries(res.staff.map((s) => [s.name, s.colour]));
    expect(byName.Alex).toBe("#abcdef");
    // Ryan was created first, so the palette index is his position (0), not the filtered list's.
    expect(byName.Ryan).toBe(STAFF_PALETTE[0]);
    expect(res.viewer).toMatchObject({ seesAll: true, refund: true, reassign: true });
  });

  test("palette colours stay with each person when the team changes", async () => {
    const before = await listCalendarResources(t.db, OWNER);
    await createStaff(t.db, seed.biz.id, { name: "Casey", email: "casey@example.com" });
    const after = await listCalendarResources(t.db, OWNER);
    for (const s of before.staff) {
      expect(after.staff.find((x) => x.id === s.id)?.colour).toBe(s.colour);
    }
  });

  test("reception sees everyone but cannot refund or merge", async () => {
    const res = await listCalendarResources(t.db, RECEPTION);
    expect(res.viewer).toMatchObject({ seesAll: true, refund: false, mergeClients: false });
    expect(res.staff).toHaveLength(3);
  });
});

describe("booking detail", () => {
  test("a stylist cannot read a colleague's booking, same answer as a missing one", async () => {
    expect(await getBookingDetail(t.db, blakeBooking.id, asAlex(), NOW)).toBeNull();
    expect(await getBookingDetail(t.db, crypto.randomUUID(), asAlex(), NOW)).toBeNull();
    expect((await getBookingDetail(t.db, alexBooking.id, asAlex(), NOW))?.id).toBe(alexBooking.id);
  });

  test("a stylist cannot refund or change stylist; the owner can, with the other stylists listed", async () => {
    const mine = await getBookingDetail(t.db, alexBooking.id, asAlex(), NOW);
    expect(mine?.allowed).toMatchObject({
      move: true,
      cancel: true,
      checkout: true,
      refund: false,
      reassign: false,
    });
    expect(mine?.reassignOptions).toEqual([]);

    const owners = await getBookingDetail(t.db, alexBooking.id, OWNER, NOW);
    expect(owners?.allowed).toMatchObject({ refund: true, reassign: true });
    expect(owners?.staff).toMatchObject({ id: alex.id, name: "Alex" });
    expect(owners?.reassignOptions.map((s) => s.name)).toEqual(["Blake", "Ryan"]);
  });

  test("reassign is only offered for confirmed future bookings", async () => {
    await t.db.update(booking).set({ status: "completed" }).where(eq(booking.id, alexBooking.id));
    const done = await getBookingDetail(t.db, alexBooking.id, MANAGER, NOW);
    expect(done?.allowed.reassign).toBe(false);
    const started = await getBookingDetail(
      t.db,
      blakeBooking.id,
      MANAGER,
      new Date("2026-11-16T03:30:00Z"),
    );
    expect(started?.allowed.reassign).toBe(false);
  });
});

describe("bookings list", () => {
  test("a stylist lists only their own bookings, others list everyone's with names", async () => {
    const mine = await listBookings(t.db, asAlex(), { filter: "upcoming", now: NOW });
    expect(mine.map((r) => r.id)).toEqual([alexBooking.id]);
    expect(mine[0]).toMatchObject({ staffId: alex.id, staffName: "Alex" });

    const all = await listBookings(t.db, RECEPTION, { filter: "upcoming", now: NOW });
    expect(all.map((r) => r.staffName).sort()).toEqual(["Alex", "Blake"]);
  });

  test("search never leaks a colleague's booking", async () => {
    const rows = await listBookings(t.db, asAlex(), { filter: "upcoming", q: "Sam", now: NOW });
    expect(rows.map((r) => r.id)).toEqual([alexBooking.id]);
  });
});

describe("checkout view", () => {
  test("a stylist can check out their own booking only", async () => {
    expect((await getCheckoutView(t.db, alexBooking.id, asAlex()))?.bookingId).toBe(alexBooking.id);
    expect(await getCheckoutView(t.db, blakeBooking.id, asAlex())).toBeNull();
  });

  test("reception and managers can check out any booking", async () => {
    expect(await getCheckoutView(t.db, blakeBooking.id, RECEPTION)).not.toBeNull();
    expect(await getCheckoutView(t.db, alexBooking.id, MANAGER)).not.toBeNull();
  });
});

describe("blocks", () => {
  const window = {
    start: new Date("2026-11-16T05:00:00Z"),
    end: new Date("2026-11-16T06:00:00Z"),
  };

  test("a stylist blocks their own time but not a colleague's", async () => {
    await expect(
      createManualBlock(t.db, { staffId: alex.id, ...window }, "staff:u2", asAlex()),
    ).resolves.toMatchObject({ overlappingBookings: 0 });
    await expect(
      createManualBlock(t.db, { staffId: blake.id, ...window }, "staff:u2", asAlex()),
    ).rejects.toThrow(/permission/i);
  });

  test("a stylist cannot delete a colleague's block, which reads as not found", async () => {
    const [theirs] = await t.db
      .insert(timeBlock)
      .values({ staffId: blake.id, during: window, source: "manual" })
      .returning();
    await expect(deleteBlock(t.db, theirs.id, "staff:u2", asAlex())).rejects.toThrow(/not found/i);
    expect(await t.db.select().from(timeBlock)).toHaveLength(1);
    await deleteBlock(t.db, theirs.id, "owner:u1", OWNER);
    expect(await t.db.select().from(timeBlock)).toHaveLength(0);
  });

  test("reception may block any stylist's time", async () => {
    await expect(
      createManualBlock(t.db, { staffId: blake.id, ...window }, "staff:u3", RECEPTION),
    ).resolves.toBeDefined();
  });
});

describe("clients", () => {
  test("a stylist sees the client's record but only their own bookings with them", async () => {
    await t.db.insert(bookingService).values({
      bookingId: blakeBooking.id,
      name: "Colour",
      durationMin: 60,
      priceCents: 100,
    });
    const profile = await getClientProfile(t.db, seed.cl.id, asAlex(), NOW);
    expect(profile?.history.map((h) => h.id)).toEqual([alexBooking.id]);
    expect(profile?.stats.upcomingCount).toBe(1);
    const full = await getClientProfile(t.db, seed.cl.id, OWNER, NOW);
    expect(full?.history).toHaveLength(2);
    expect(full?.stats.upcomingCount).toBe(2);
  });

  test("every role can search clients and a stylist can edit notes", async () => {
    for (const who of [asAlex(), OWNER, MANAGER, RECEPTION]) {
      expect((await searchClients(t.db, who, { q: "Sam" })).length).toBe(1);
    }
    await updateClientNotes(t.db, seed.cl.id, "Prefers a #2", "staff:u2", asAlex());
    const [row] = await t.db.select().from(client).where(eq(client.id, seed.cl.id));
    expect(row.notes).toBe("Prefers a #2");
  });
});
