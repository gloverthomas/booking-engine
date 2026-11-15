import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NotFoundError } from "@/server/booking";
import {
  cancelWaitlistEntry,
  createWaitlistOffer,
  listOfferableSlots,
  listWaitlist,
} from "@/server/waitlist";
import { addBlock, createWorld, local, type World } from "../availability/setup";
import { NOW, join, offerTo, person } from "./setup";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("listWaitlist", () => {
  test("lists active entries oldest first with client, services, window and offers", async () => {
    const first = await join(w, { client: person(1), now: NOW });
    await join(w, { client: person(2), now: new Date(NOW.getTime() + 1000), weekdays: [1, 3] });
    await offerTo(w, first.entryId);

    const rows = await listWaitlist(w.db, "active");
    expect(rows.map((r) => r.id)[0]).toBe(first.entryId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      clientName: "Person1 Waiting",
      serviceNames: ["Maintenance Haircut"],
      locationName: "Northside",
      staffName: null,
      status: "offered",
    });
    expect(rows[0].offers[0]).toMatchObject({
      status: "sent",
      staffName: "Ryan",
      offeredBy: "auto",
    });
    expect(rows[1].weekdays).toEqual([1, 3]);
  });

  test("history shows removed entries only", async () => {
    const a = await join(w, { client: person(1) });
    await join(w, { client: person(2) });
    await cancelWaitlistEntry(w.db, a.entryId, "staff");
    expect((await listWaitlist(w.db, "history")).map((r) => r.id)).toEqual([a.entryId]);
    expect(await listWaitlist(w.db, "active")).toHaveLength(1);
  });

  test("empty lists are fine", async () => {
    expect(await listWaitlist(w.db, "active")).toEqual([]);
  });
});

describe("listOfferableSlots", () => {
  test("returns open slots inside the entry's window, soonest first", async () => {
    const { entryId } = await join(w, {
      weekdays: [1],
      fromMinute: 600,
      toMinute: 660,
      earliestDate: "2026-11-02",
      latestDate: "2026-11-16",
    });
    await addBlock(w.db, w.staffId, local("2026-11-02T10:00"), local("2026-11-02T10:30"));
    const { slots, timezone, entry } = await listOfferableSlots(w.db, entryId, NOW);

    expect(timezone).toBe("Australia/Melbourne");
    expect(entry.id).toBe(entryId);
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts[0]).toBe(local("2026-11-02T10:30").toISOString());
    expect(starts).toContain(local("2026-11-09T10:00").toISOString());
    expect(slots.every((s) => s.staffName === "Ryan")).toBe(true);
    // Every slot is on a Monday between 10:00 and 11:00.
    expect(slots.every((s) => s.start.getTime() >= local("2026-11-02T10:00").getTime())).toBe(true);
  });

  test("a slot from the list can be offered", async () => {
    const { entryId } = await join(w);
    const { slots } = await listOfferableSlots(w.db, entryId, NOW);
    const slot = slots[0];
    const { offerId } = await createWaitlistOffer(w.db, {
      entryId,
      staffId: slot.staffId,
      during: { start: slot.start, end: slot.end },
      offeredBy: "owner:u1",
      now: NOW,
    });
    expect(offerId).toBeTruthy();
  });

  test("a finished window has no slots; unknown ids are not found", async () => {
    const { entryId } = await join(w);
    const late = new Date(local("2026-11-20T10:00"));
    expect((await listOfferableSlots(w.db, entryId, late)).slots).toEqual([]);
    await expect(listOfferableSlots(w.db, "nope", NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      listOfferableSlots(w.db, "6f1c8d3e-1111-4222-8333-444455556666", NOW),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("admin commands", () => {
  test("removeEntry cancels as the signed-in person; bad input is rejected", async () => {
    const { removeEntry } = await import("@/server/waitlist");
    const { entryRow, audits } = await import("./setup");
    const { entryId } = await join(w);
    await removeEntry(w.db, { entryId }, "owner:u1");
    expect((await entryRow(w.db, entryId)).status).toBe("cancelled");
    expect(await audits(w.db, entryId)).toContainEqual({
      action: "waitlist.cancel",
      actor: "owner:u1",
    });
    await expect(removeEntry(w.db, { entryId: "x" }, "owner:u1")).rejects.toThrow();
  });

  test("offerSlot creates an owner offer for a listed slot", async () => {
    const { offerSlot } = await import("@/server/waitlist");
    const { offerRow } = await import("./setup");
    const { entryId } = await join(w);
    const [slot] = (await listOfferableSlots(w.db, entryId, NOW)).slots;
    const { offerId } = await offerSlot(
      w.db,
      {
        entryId,
        staffId: slot.staffId,
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      },
      "owner:u1",
      NOW,
    );
    expect((await offerRow(w.db, offerId)).offeredBy).toBe("owner:u1");
    await expect(offerSlot(w.db, { entryId }, "owner:u1", NOW)).rejects.toThrow();
  });
});
