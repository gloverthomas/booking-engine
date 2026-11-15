import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cancelBooking, BookingStateError, ClientBlockedError, NotFoundError, SlotTakenError, ValidationError } from "@/server/booking";
import { client, waitlistOffer, service } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createWaitlistOffer, offerFreedSlot, cancelWaitlistEntry } from "@/server/waitlist";
import { addStaff, createWorld, local, setSettings, addBlock, type World } from "../availability/setup";
import { offer } from "../availability/setup";
import { audits, bookedSlot, entryRow, events, join, MONDAY_10, NOW, offerRow, offerTo, person } from "./setup";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

const slot = (at = MONDAY_10, minutes = 45) => ({
  staffId: w.staffId,
  locationId: w.locationId,
  start: local(at),
  end: new Date(local(at).getTime() + minutes * 60_000),
});

describe("createWaitlistOffer", () => {
  test("creates an offer held for the offer window, marks the entry offered, emits and audits", async () => {
    const { entryId } = await join(w);
    const { offerId } = await offerTo(w, entryId, MONDAY_10, "owner:u1");
    const row = await offerRow(w.db, offerId);

    expect(row.status).toBe("sent");
    expect(row.offeredBy).toBe("owner:u1");
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + 20 * 60_000));
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
    expect(await events(w.db, "waitlist.offer_created")).toEqual([{ offerId }]);
    expect(await audits(w.db, offerId)).toEqual([{ action: "waitlist.offer", actor: "owner:u1" }]);
  });

  test("the hold never outlasts the slot's start", async () => {
    await setSettings(w.db, w.businessId, { minNoticeMin: 0 });
    const { entryId } = await join(w);
    const start = local("2026-11-01T10:00");
    const { offerId } = await createWaitlistOffer(w.db, {
      entryId,
      staffId: w.staffId,
      during: { start, end: new Date(start.getTime() + 2700_000) },
      offeredBy: "owner:u1",
      now: local("2026-11-01T09:50"),
    });
    expect((await offerRow(w.db, offerId)).expiresAt).toEqual(start);
  });

  test("offering the same entry the same slot twice returns the same offer", async () => {
    const { entryId } = await join(w);
    const a = await offerTo(w, entryId);
    const b = await offerTo(w, entryId);
    expect(b.offerId).toBe(a.offerId);
    expect(await events(w.db, "waitlist.offer_created")).toHaveLength(1);
  });

  test("refuses a slot that is not bookable", async () => {
    const { entryId } = await join(w);
    await bookedSlot(w);
    await expect(offerTo(w, entryId)).rejects.toBeInstanceOf(SlotTakenError);
    await expect(offerTo(w, entryId, "2026-11-02T20:00")).rejects.toBeInstanceOf(SlotTakenError);
  });

  test("refuses past slots, bad input, unknown and finished entries", async () => {
    const { entryId } = await join(w);
    await expect(
      createWaitlistOffer(w.db, {
        entryId,
        staffId: w.staffId,
        during: { start: local("2026-10-30T10:00"), end: local("2026-10-30T10:45") },
        offeredBy: "auto",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createWaitlistOffer(w.db, {
        entryId,
        staffId: w.staffId,
        during: { start: local(MONDAY_10), end: local(MONDAY_10) },
        offeredBy: "auto",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createWaitlistOffer(w.db, {
        entryId,
        staffId: w.staffId,
        during: { start: local(MONDAY_10), end: local("2026-11-02T10:45") },
        offeredBy: "somebody",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      offerTo({ ...w, haircutId: w.haircutId }, "6f1c8d3e-1111-4222-8333-444455556666"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await cancelWaitlistEntry(w.db, entryId, "client");
    await expect(offerTo(w, entryId)).rejects.toBeInstanceOf(BookingStateError);
  });

  test("refuses blocked clients", async () => {
    const { entryId } = await join(w);
    await w.db.update(client).set({ blocked: true }).where(eq(client.email, "person1@example.com"));
    await expect(offerTo(w, entryId)).rejects.toBeInstanceOf(ClientBlockedError);
  });

  test("an automatic offer respects the stylist the person asked for; the owner may override", async () => {
    const alex = await addStaff(w.db, w.businessId, "Alex");
    await offer(w.db, w.haircutId, w.locationId, alex.id);
    const { openEveryDay } = await import("../availability/setup");
    await openEveryDay(w.db, alex.id, w.locationId);
    const { entryId } = await join(w, { staffId: w.staffId });
    const start = local(MONDAY_10);
    const during = { start, end: new Date(start.getTime() + 2700_000) };
    await expect(
      createWaitlistOffer(w.db, { entryId, staffId: alex.id, during, offeredBy: "auto", now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createWaitlistOffer(w.db, { entryId, staffId: alex.id, during, offeredBy: "owner:u1", now: NOW }),
    ).resolves.toHaveProperty("offerId");
  });
});

describe("offerFreedSlot", () => {
  test("offers a freed slot to a matching entry", async () => {
    const { entryId } = await join(w);
    const booked = await bookedSlot(w);
    await cancelBooking(w.db, { bookingId: booked.bookingId, by: "client", now: NOW });
    const result = await offerFreedSlot(w.db, slot(), NOW);
    expect(result.offerIds).toHaveLength(1);
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
  });

  test("does nothing twice for the same slot", async () => {
    await join(w);
    const first = await offerFreedSlot(w.db, slot(), NOW);
    const second = await offerFreedSlot(w.db, slot(), NOW);
    expect(first.offerIds).toHaveLength(1);
    expect(second.offerIds).toHaveLength(0);
    expect(await events(w.db, "waitlist.offer_created")).toHaveLength(1);
  });

  test("offers oldest entries first, up to the per-slot maximum", async () => {
    await setSettings(w.db, w.businessId, { waitlistMaxOffersPerSlot: 2 });
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const { entryId } = await join(w, {
        client: person(i),
        now: new Date(NOW.getTime() + i * 1000),
      });
      ids.push(entryId);
    }
    const { offerIds } = await offerFreedSlot(w.db, slot(), NOW);
    expect(offerIds).toHaveLength(2);
    const rows = await w.db.select().from(waitlistOffer);
    expect(rows.map((r) => r.entryId).sort()).toEqual([ids[0], ids[1]].sort());
    expect((await entryRow(w.db, ids[2])).status).toBe("waiting");
    // Open offers count against the maximum on a re-run.
    expect((await offerFreedSlot(w.db, slot(), NOW)).offerIds).toHaveLength(0);
  });

  test("skips the client whose booking freed the slot", async () => {
    const booked = await bookedSlot(w, MONDAY_10, person(1));
    await join(w);
    await cancelBooking(w.db, { bookingId: booked.bookingId, by: "client", now: NOW });
    const [row] = await w.db.select().from(client).where(eq(client.email, "person1@example.com"));
    const result = await offerFreedSlot(w.db, { ...slot(), excludeClientId: row.id }, NOW);
    expect(result.offerIds).toHaveLength(0);
  });

  test.each([
    ["auto-offer is off", { waitlistAutoOffer: false }, MONDAY_10],
    ["the waitlist is off", { waitlistEnabled: false }, MONDAY_10],
    ["the slot starts inside the minimum notice", {}, "2026-11-01T09:00"],
    ["the slot has passed", {}, "2026-10-31T10:00"],
  ])("makes no offers when %s", async (_label, settings, at) => {
    await join(w);
    await setSettings(w.db, w.businessId, settings);
    expect((await offerFreedSlot(w.db, slot(at), NOW)).offerIds).toEqual([]);
  });

  test("respects date, weekday and time-of-day windows", async () => {
    const wrongDay = await join(w, { client: person(1), weekdays: [3] });
    const wrongTime = await join(w, { client: person(2), fromMinute: 780, toMinute: 1000 });
    const outOfRange = await join(w, { client: person(3), earliestDate: "2026-11-04" });
    const rightTime = await join(w, { client: person(4), weekdays: [1], fromMinute: 600, toMinute: 600 });
    const { offerIds } = await offerFreedSlot(w.db, slot(), NOW);
    expect(offerIds).toHaveLength(1);
    expect((await entryRow(w.db, rightTime.entryId)).status).toBe("offered");
    for (const e of [wrongDay, wrongTime, outOfRange]) {
      expect((await entryRow(w.db, e.entryId)).status).toBe("waiting");
    }
  });

  test("only offers to entries whose services fit the freed range", async () => {
    const long = await (await import("../helpers/factories")).createService(w.db, w.businessId, {
      name: "Long colour",
      durationMin: 120,
    });
    await offer(w.db, long.id, w.locationId, w.staffId);
    const longEntry = await join(w, { client: person(1), serviceIds: [long.id] });
    const shortEntry = await join(w, { client: person(2) });
    const result = await offerFreedSlot(w.db, slot(MONDAY_10, 60), NOW);
    expect(result.offerIds).toHaveLength(1);
    expect((await entryRow(w.db, longEntry.entryId)).status).toBe("waiting");
    expect((await entryRow(w.db, shortEntry.entryId)).status).toBe("offered");
    const wide = await offerFreedSlot(w.db, slot("2026-11-03T10:00", 150), NOW);
    expect(wide.offerIds).toHaveLength(2);
    const during = (await w.db.select().from(waitlistOffer)).map((o) => o.during.end.getTime() - o.during.start.getTime());
    expect(during.sort()).toEqual([45 * 60_000, 45 * 60_000, 120 * 60_000]);
  });

  test("an entry for another stylist or location is skipped", async () => {
    const alex = await addStaff(w.db, w.businessId, "Alex");
    await offer(w.db, w.haircutId, w.locationId, alex.id);
    await join(w, { staffId: alex.id });
    expect((await offerFreedSlot(w.db, slot(), NOW)).offerIds).toHaveLength(0);
  });

  test("skips a slot that has been blocked or rebooked since it was freed", async () => {
    await join(w);
    await addBlock(w.db, w.staffId, local("2026-11-02T09:30"), local("2026-11-02T11:00"));
    expect((await offerFreedSlot(w.db, slot(), NOW)).offerIds).toHaveLength(0);
  });

  test("ignores a service that stopped being offered and malformed ids", async () => {
    await join(w);
    await w.db.update(service).set({ active: false }).where(eq(service.id, w.haircutId));
    expect((await offerFreedSlot(w.db, slot(), NOW)).offerIds).toHaveLength(0);
    expect((await offerFreedSlot(w.db, { ...slot(), staffId: "x" }, NOW)).offerIds).toHaveLength(0);
  });
});
