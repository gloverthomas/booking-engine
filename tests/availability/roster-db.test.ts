import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { location, rosterException, serviceLocation } from "@/db/schema";
import { getAvailableSlots } from "@/server/availability";
import {
  MONDAY,
  NOW,
  addStaff,
  createWorld,
  localTime,
  offer,
  openEveryDay,
  type World,
} from "./setup";

let w: World;
let otherLocationId: string;

beforeEach(async () => {
  w = await createWorld({ minNoticeMin: 0 });
  const [other] = await w.db
    .insert(location)
    .values({ businessId: w.businessId, name: "Southside" })
    .returning();
  otherLocationId = other.id;
  // The same haircut is offered at both places, and the stylist works 9-5 at both.
  await w.db
    .insert(serviceLocation)
    .values({ serviceId: w.haircutId, locationId: otherLocationId });
  await openEveryDay(w.db, w.staffId, otherLocationId);
});

afterEach(async () => {
  await w.t.client.close();
});

const times = async (locationId: string, date = MONDAY) =>
  (
    await getAvailableSlots(w.db, {
      locationId,
      staffId: w.staffId,
      serviceIds: [w.haircutId],
      fromDate: date,
      toDate: date,
      now: NOW,
    })
  ).map((s) => localTime(s.start));

const addException = (values: Partial<typeof rosterException.$inferInsert>) =>
  w.db.insert(rosterException).values({ staffId: w.staffId, date: MONDAY, kind: "off", ...values });

describe("roster exceptions in the availability search", () => {
  test("a day off at one location leaves the other location open that day", async () => {
    await addException({ locationId: w.locationId });
    expect(await times(w.locationId)).toEqual([]);
    expect((await times(otherLocationId)).length).toBe(30);
  });

  test("a day off with no location removes the day everywhere", async () => {
    await addException({ locationId: null });
    expect(await times(w.locationId)).toEqual([]);
    expect(await times(otherLocationId)).toEqual([]);
  });

  test("custom hours replace the weekly hours at their location only", async () => {
    await addException({
      locationId: w.locationId,
      kind: "custom",
      startMinute: 600,
      endMinute: 720,
    });
    const here = await times(w.locationId);
    expect(here[0]).toBe("10:00");
    expect(here.at(-1)).toBe("11:15");
    // the same day at the other place is still the weekly 9-5
    expect((await times(otherLocationId))[0]).toBe("09:00");
  });

  test("two locations in one day: off at one and custom at the other", async () => {
    await addException({ locationId: w.locationId });
    await addException({
      locationId: otherLocationId,
      kind: "custom",
      startMinute: 780,
      endMinute: 900,
    });
    expect(await times(w.locationId)).toEqual([]);
    const other = await times(otherLocationId);
    expect(other[0]).toBe("13:00");
    expect(other.at(-1)).toBe("14:15");
  });

  test("an exception on another date does not change this date", async () => {
    await addException({ date: "2026-11-09" });
    expect((await times(w.locationId)).length).toBe(30);
    expect(await times(w.locationId, "2026-11-09")).toEqual([]);
  });

  test("exceptions belong to one stylist", async () => {
    const zed = await addStaff(w.db, w.businessId, "Zed");
    await offer(w.db, w.haircutId, w.locationId, zed.id);
    await openEveryDay(w.db, zed.id, w.locationId);
    await addException({ locationId: null });
    const slots = await getAvailableSlots(w.db, {
      locationId: w.locationId,
      serviceIds: [w.haircutId],
      fromDate: MONDAY,
      toDate: MONDAY,
      now: NOW,
    });
    expect(slots.length).toBe(30);
    expect(new Set(slots.map((s) => s.staffId))).toEqual(new Set([zed.id]));
  });
});
