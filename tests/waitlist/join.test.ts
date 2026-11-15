import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { client, location, service, waitlistEntry } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  ClientBlockedError,
  NotFoundError,
  ValidationError,
  VipOnlyError,
} from "@/server/booking";
import { cancelWaitlistEntry, WaitlistDisabledError } from "@/server/waitlist";
import { MAX_ACTIVE_ENTRIES_PER_CLIENT } from "@/server/waitlist";
import { addStaff, createWorld, local, setSettings, type World } from "../availability/setup";
import { createService } from "../helpers/factories";
import { audits, entryRow, events, join, joinInput, NOW, offerRow, offerTo, person } from "./setup";
import { joinWaitlist } from "@/server/waitlist";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("joinWaitlist", () => {
  test("creates a waiting entry that expires at the end of the last date, emits an event and audits", async () => {
    const { entryId } = await join(w, { weekdays: [3, 1, 1], fromMinute: 540, toMinute: 780 });
    const row = await entryRow(w.db, entryId);

    expect(row.status).toBe("waiting");
    expect(row.weekdays).toEqual([1, 3]);
    expect([row.fromMinute, row.toMinute]).toEqual([540, 780]);
    expect(row.expiresAt).toEqual(local("2026-11-06T23:59:59.999"));
    expect(await events(w.db, "waitlist.entry_joined")).toEqual([{ entryId }]);
    expect(await audits(w.db, entryId)).toEqual([{ action: "waitlist.join", actor: "client" }]);
  });

  test("returns the same entry for an identical active request", async () => {
    const a = await join(w);
    const b = await join(w);
    expect(b.entryId).toBe(a.entryId);
    expect(await w.db.select().from(waitlistEntry)).toHaveLength(1);
    expect(await events(w.db, "waitlist.entry_joined")).toHaveLength(1);
  });

  test("a different window is a different entry", async () => {
    const a = await join(w);
    const b = await join(w, { latestDate: "2026-11-07" });
    expect(b.entryId).not.toBe(a.entryId);
  });

  test("seven weekdays and a full day mean 'any'", async () => {
    const { entryId } = await join(w, {
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      fromMinute: 0,
      toMinute: 1439,
    });
    const row = await entryRow(w.db, entryId);
    expect([row.weekdays, row.fromMinute, row.toMinute]).toEqual([null, null, null]);
  });

  test("clamps a start date in the past to today and a far end date to the booking horizon", async () => {
    const { entryId } = await join(w, { earliestDate: "2026-10-01", latestDate: "2027-12-31" });
    const row = await entryRow(w.db, entryId);
    expect(row.earliestDate).toBe("2026-11-01");
    expect(row.latestDate).toBe("2027-01-30");
  });

  test.each([
    ["a window wholly in the past", { earliestDate: "2026-10-01", latestDate: "2026-10-20" }],
    ["a first date after the last", { earliestDate: "2026-11-09", latestDate: "2026-11-03" }],
    ["a window beyond the horizon", { earliestDate: "2027-06-01", latestDate: "2027-06-10" }],
    ["a bad date", { earliestDate: "2026-13-45" }],
    ["inverted minutes", { fromMinute: 900, toMinute: 600 }],
    ["a weekday out of range", { weekdays: [7] }],
    ["no services", { serviceIds: [] }],
    ["an unknown service", { serviceIds: ["6f1c8d3e-1111-4222-8333-444455556666"] }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(join(w, overrides)).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects a service not offered at the location", async () => {
    const other = await createService(w.db, w.businessId, { name: "Colour" });
    await expect(join(w, { serviceIds: [other.id] })).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects a stylist who does not offer the services", async () => {
    const alex = await addStaff(w.db, w.businessId, "Alex");
    await expect(join(w, { staffId: alex.id })).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects bad client details", async () => {
    await expect(join(w, { client: { ...person(1), phone: "nope" } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test("refuses when the waitlist is off", async () => {
    await setSettings(w.db, w.businessId, { waitlistEnabled: false });
    await expect(join(w)).rejects.toBeInstanceOf(WaitlistDisabledError);
  });

  test("refuses blocked clients", async () => {
    await join(w);
    await w.db.update(client).set({ blocked: true }).where(eq(client.email, "person1@example.com"));
    await expect(join(w, { latestDate: "2026-11-09" })).rejects.toBeInstanceOf(ClientBlockedError);
  });

  test("VIP-only services need a VIP client", async () => {
    await w.db.update(service).set({ vipOnly: true }).where(eq(service.id, w.haircutId));
    await expect(join(w)).rejects.toBeInstanceOf(VipOnlyError);
  });

  test("caps the number of active entries per client", async () => {
    for (let i = 0; i < MAX_ACTIVE_ENTRIES_PER_CLIENT; i += 1) {
      await join(w, { latestDate: `2026-11-${String(10 + i).padStart(2, "0")}` });
    }
    await expect(join(w, { latestDate: "2026-11-30" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("an inactive location is refused", async () => {
    await w.db.update(location).set({ active: false });
    await expect(joinWaitlist(w.db, joinInput(w))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("cancelWaitlistEntry", () => {
  test("cancels, is idempotent, and audits once", async () => {
    const { entryId } = await join(w);
    await cancelWaitlistEntry(w.db, entryId, "client", { now: NOW });
    await cancelWaitlistEntry(w.db, entryId, "client", { now: NOW });
    expect((await entryRow(w.db, entryId)).status).toBe("cancelled");
    expect((await audits(w.db, entryId)).filter((a) => a.action === "waitlist.cancel")).toHaveLength(1);
  });

  test("staff cancellation records the given actor", async () => {
    const { entryId } = await join(w);
    await cancelWaitlistEntry(w.db, entryId, "staff", { actor: "owner:u1" });
    expect(await audits(w.db, entryId)).toContainEqual({
      action: "waitlist.cancel",
      actor: "owner:u1",
    });
  });

  test("withdraws open offers", async () => {
    const { entryId } = await join(w);
    const { offerId } = await offerTo(w, entryId);
    await cancelWaitlistEntry(w.db, entryId, "client");
    expect((await offerRow(w.db, offerId)).status).toBe("cancelled");
  });

  test("unknown or malformed ids are not found", async () => {
    await expect(cancelWaitlistEntry(w.db, "nope", "client")).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      cancelWaitlistEntry(w.db, "6f1c8d3e-1111-4222-8333-444455556666", "client"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
