import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { serviceLevelPrice, serviceStaff, staff } from "@/db/schema";
import { getAvailableSlots, searchAvailability } from "@/server/availability";
import { createService } from "../helpers/factories";
import {
  MONDAY,
  NOW,
  addBooking,
  addStaff,
  createWorld,
  localTime,
  local,
  offer,
  openEveryDay,
  type World,
} from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld({ minNoticeMin: 0 });
});

afterEach(async () => {
  await w.t.client.close();
});

const query = (overrides: Record<string, unknown> = {}) => ({
  locationId: w.locationId,
  staffId: w.staffId,
  serviceIds: [w.haircutId],
  fromDate: MONDAY,
  toDate: MONDAY,
  now: NOW,
  ...overrides,
});

async function setLevel(staffId: string, level: number) {
  await w.db.update(staff).set({ level }).where(eq(staff.id, staffId));
}

async function levelPrice(
  serviceId: string,
  level: number,
  values: { priceCents?: number; durationMin?: number },
) {
  await w.db.insert(serviceLevelPrice).values({
    serviceId,
    level,
    priceCents: values.priceCents ?? null,
    durationMin: values.durationMin ?? null,
  });
}

async function firstPlan(overrides: Record<string, unknown> = {}) {
  const search = await searchAvailability(w.db, query(overrides));
  const plan = search.plans.get((overrides.staffId as string | undefined) ?? w.staffId);
  if (!plan) throw new Error("no plan");
  return plan;
}

describe("level pricing precedence", () => {
  test("with no level prices the service default applies", async () => {
    const plan = await firstPlan();
    expect(plan.totalCents).toBe(9500);
    expect(plan.durationMin).toBe(45);
  });

  test("the price for the stylist's level beats the service default", async () => {
    await setLevel(w.staffId, 2);
    await levelPrice(w.haircutId, 2, { priceCents: 13000 });
    const plan = await firstPlan();
    expect(plan.level).toBe(2);
    expect(plan.totalCents).toBe(13000);
    expect(plan.durationMin).toBe(45); // price-only row: duration falls back
  });

  test("a level price can change the duration too", async () => {
    await setLevel(w.staffId, 1);
    await levelPrice(w.haircutId, 1, { priceCents: 8000, durationMin: 60 });
    const [first] = await getAvailableSlots(w.db, query());
    expect(localTime(first.end)).toBe("10:00");
    expect(first).toMatchObject({ totalCents: 8000, durationMin: 60 });
  });

  test("the stylist's own override beats the level price, field by field", async () => {
    await setLevel(w.staffId, 2);
    await levelPrice(w.haircutId, 2, { priceCents: 13000, durationMin: 50 });
    await w.db
      .update(serviceStaff)
      .set({ priceCents: 15000 })
      .where(eq(serviceStaff.staffId, w.staffId));
    const plan = await firstPlan();
    expect(plan.totalCents).toBe(15000); // own price
    expect(plan.durationMin).toBe(50); // no own duration, so the level's
  });

  test("a price set for another level is ignored", async () => {
    await setLevel(w.staffId, 1);
    await levelPrice(w.haircutId, 3, { priceCents: 20000 });
    expect((await firstPlan()).totalCents).toBe(9500);
  });
});

describe("multi-service bookings are priced per stylist", () => {
  test("each stylist's total uses their own level for every service", async () => {
    const colour = await createService(w.db, w.businessId, {
      name: "Colour",
      durationMin: 60,
      priceCents: 12000,
    });
    await offer(w.db, colour.id, w.locationId, w.staffId);
    const senior = await addStaff(w.db, w.businessId, "Zed");
    await setLevel(senior.id, 2);
    await offer(w.db, w.haircutId, w.locationId, senior.id);
    await offer(w.db, colour.id, w.locationId, senior.id);
    await openEveryDay(w.db, senior.id, w.locationId);
    await levelPrice(w.haircutId, 2, { priceCents: 11000 });
    await levelPrice(colour.id, 2, { priceCents: 16000, durationMin: 75 });

    const search = await searchAvailability(w.db, {
      ...query({ staffId: undefined, serviceIds: [w.haircutId, colour.id] }),
    });
    expect(search.plans.get(w.staffId)).toMatchObject({ totalCents: 21500, durationMin: 105 });
    expect(search.plans.get(senior.id)).toMatchObject({ totalCents: 27000, durationMin: 120 });
  });
});

describe("first available returns the assigned stylist's own price", () => {
  test("each slot carries the total and length for the stylist it is assigned to", async () => {
    const senior = await addStaff(w.db, w.businessId, "Aaron"); // sorts first
    await setLevel(senior.id, 2);
    await offer(w.db, w.haircutId, w.locationId, senior.id);
    await openEveryDay(w.db, senior.id, w.locationId);
    await levelPrice(w.haircutId, 2, { priceCents: 14000 });
    // Aaron is busy 09:00-10:00, so Ryan (level 0, $95) takes those starts
    await addBooking(
      w.db,
      { ...w, staffId: senior.id },
      local("2026-11-02T09:00"),
      local("2026-11-02T10:00"),
    );

    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    const nine = slots.find((s) => localTime(s.start) === "09:00");
    expect(nine).toMatchObject({ staffId: w.staffId, totalCents: 9500 });
    // Aaron has a booking that day and Ryan has none, so Ryan also takes the later starts
    const eleven = slots.find((s) => localTime(s.start) === "11:00");
    expect(eleven).toMatchObject({ staffId: w.staffId, totalCents: 9500 });
  });
});

describe("first available balances the day", () => {
  async function twoStylists() {
    const amy = await addStaff(w.db, w.businessId, "Amy");
    await offer(w.db, w.haircutId, w.locationId, amy.id);
    await openEveryDay(w.db, amy.id, w.locationId);
    return amy;
  }

  test("ties are broken alphabetically", async () => {
    const amy = await twoStylists(); // Amy < Ryan
    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    expect(slots.every((s) => s.staffId === amy.id)).toBe(true);
  });

  test("the stylist with the fewest bookings that day is preferred over alphabetical order", async () => {
    const amy = await twoStylists();
    await addBooking(
      w.db,
      { ...w, staffId: amy.id },
      local("2026-11-02T09:00"),
      local("2026-11-02T09:45"),
    );
    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    const ten = slots.find((s) => localTime(s.start) === "10:00");
    expect(ten?.staffId).toBe(w.staffId); // Ryan has none, Amy has one
  });

  test("the count is per day: a booking on another day does not tip the balance", async () => {
    const amy = await twoStylists();
    await addBooking(
      w.db,
      { ...w, staffId: amy.id },
      local("2026-11-03T09:00"),
      local("2026-11-03T09:45"),
    );
    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    expect(slots.find((s) => localTime(s.start) === "10:00")?.staffId).toBe(amy.id);
  });

  test("lapsed holds and cancelled bookings do not count", async () => {
    const amy = await twoStylists();
    await addBooking(
      w.db,
      { ...w, staffId: amy.id },
      local("2026-11-02T09:00"),
      local("2026-11-02T09:45"),
      {
        status: "cancelled_by_client",
      },
    );
    await addBooking(
      w.db,
      { ...w, staffId: amy.id },
      local("2026-11-02T11:00"),
      local("2026-11-02T11:45"),
      {
        status: "pending_payment",
        holdExpiresAt: new Date(NOW.getTime() - 60_000),
      },
    );
    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    expect(slots.find((s) => localTime(s.start) === "10:00")?.staffId).toBe(amy.id);
  });

  test("a stylist who is not free at that time is never chosen", async () => {
    const amy = await twoStylists();
    const amyBooked = { ...w, staffId: amy.id };
    await addBooking(w.db, w, local("2026-11-02T09:00"), local("2026-11-02T12:00")); // Ryan: 1 booking, busy
    await addBooking(w.db, amyBooked, local("2026-11-02T13:00"), local("2026-11-02T13:45"));
    await addBooking(w.db, amyBooked, local("2026-11-02T14:00"), local("2026-11-02T14:45"));
    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    // Ryan has fewer bookings (1 vs 2) but is busy at 10:00, so Amy takes it
    expect(slots.find((s) => localTime(s.start) === "10:00")?.staffId).toBe(amy.id);
    // once Ryan is free again he is preferred
    expect(slots.find((s) => localTime(s.start) === "12:00")?.staffId).toBe(w.staffId);
  });
});
