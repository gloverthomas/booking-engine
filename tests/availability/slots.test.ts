import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { availabilityRule, business, location, service, serviceStaff, staff } from "@/db/schema";
import { getAvailableSlots, searchAvailability } from "@/server/availability";
import { ValidationError } from "@/server/booking/errors";
import { createService } from "../helpers/factories";
import {
  MONDAY,
  NOW,
  addBlock,
  addBooking,
  addStaff,
  createWorld,
  local,
  localTime,
  offer,
  openEveryDay,
  setSettings,
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

const times = async (overrides: Record<string, unknown> = {}) =>
  (await getAvailableSlots(w.db, query(overrides))).map((s) => localTime(s.start));

describe("getAvailableSlots: basics", () => {
  test("returns the daily grid for one service, with the staff id on each slot", async () => {
    const slots = await getAvailableSlots(w.db, query());
    expect(slots).toHaveLength(30);
    expect(slots[0]).toMatchObject({ staffId: w.staffId });
    expect(localTime(slots[0].start)).toBe("09:00");
    expect(localTime(slots[0].end)).toBe("09:45");
  });

  test("uses the business timezone, not UTC offsets", async () => {
    const [first] = await getAvailableSlots(w.db, query());
    // 09:00 AEDT (+11) on 2026-11-02 is 22:00Z the day before
    expect(first.start.toISOString()).toBe("2026-11-01T22:00:00.000Z");
  });

  test("an unknown location is a not-found error and bad input a validation error", async () => {
    await expect(
      getAvailableSlots(w.db, query({ locationId: "00000000-0000-4000-8000-000000000000" })),
    ).rejects.toThrow(/Location not found/);
    await expect(getAvailableSlots(w.db, query({ fromDate: "11/02/2026" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(getAvailableSlots(w.db, query({ serviceIds: [] }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      getAvailableSlots(w.db, query({ fromDate: "2026-11-05", toDate: "2026-11-02" })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      getAvailableSlots(w.db, query({ fromDate: "2026-11-02", toDate: "2028-11-02" })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("an inactive location has no availability", async () => {
    await w.db.update(location).set({ active: false }).where(eq(location.id, w.locationId));
    expect(await times()).toEqual([]);
  });

  test("honours the configured slot step", async () => {
    await setSettings(w.db, w.businessId, { minNoticeMin: 0, slotStepMin: 30 });
    expect((await times()).slice(0, 3)).toEqual(["09:00", "09:30", "10:00"]);
  });

  test("a different business timezone shifts the slots", async () => {
    await w.db
      .update(business)
      .set({ timezone: "Australia/Perth" })
      .where(eq(business.id, w.businessId));
    const [first] = await getAvailableSlots(w.db, query());
    // 09:00 AWST (+8) is 01:00Z
    expect(first.start.toISOString()).toBe("2026-11-02T01:00:00.000Z");
  });
});

describe("getAvailableSlots: services", () => {
  test("sums the duration of multiple services", async () => {
    const colour = await createService(w.db, w.businessId, { name: "Colour", durationMin: 75 });
    await offer(w.db, colour.id, w.locationId, w.staffId);
    const slots = await getAvailableSlots(w.db, query({ serviceIds: [w.haircutId, colour.id] }));
    expect(localTime(slots[0].end)).toBe("11:00"); // 45 + 75 = 120 min
    expect(localTime(slots.at(-1)!.start)).toBe("15:00");
  });

  test("the last service's buffer occupies the stylist after the appointment", async () => {
    const colour = await createService(w.db, w.businessId, {
      name: "Colour",
      durationMin: 60,
      bufferMin: 30,
    });
    await offer(w.db, colour.id, w.locationId, w.staffId);
    // someone is booked 11:00-12:00
    await addBooking(w.db, w, local("2026-11-02T11:00"), local("2026-11-02T12:00"));
    const slots = await times({ serviceIds: [colour.id] });
    expect(slots).toContain("09:30"); // 09:30-10:30 + 30 buffer = 11:00, touching only
    expect(slots).not.toContain("09:45");
  });

  test("only the LAST service's buffer counts, whatever the order", async () => {
    const buffered = await createService(w.db, w.businessId, {
      name: "Buffered",
      durationMin: 30,
      bufferMin: 30,
    });
    await offer(w.db, buffered.id, w.locationId, w.staffId);
    await addBooking(w.db, w, local("2026-11-02T11:00"), local("2026-11-02T12:00"));
    // 75 minutes in total; with the haircut last there is no buffer, so 09:45 ends exactly at 11:00
    const haircutLast = await times({ serviceIds: [buffered.id, w.haircutId] });
    expect(haircutLast).toContain("09:45");
    const bufferedLast = await times({ serviceIds: [w.haircutId, buffered.id] });
    expect(bufferedLast).not.toContain("09:30"); // 09:30 + 75 + 30 buffer runs into 11:00-12:00
    expect(bufferedLast).toContain("09:15");
  });

  test("per-staff duration overrides change the slot length", async () => {
    await w.db
      .update(serviceStaff)
      .set({ durationMin: 60 })
      .where(eq(serviceStaff.serviceId, w.haircutId));
    const [first] = await getAvailableSlots(w.db, query());
    expect(localTime(first.end)).toBe("10:00");
  });

  test("an inactive service, or one not offered at the location, yields nothing", async () => {
    await w.db.update(service).set({ active: false }).where(eq(service.id, w.haircutId));
    expect(await times()).toEqual([]);

    const other = await createService(w.db, w.businessId, { name: "Elsewhere" });
    await w.db.insert(serviceStaff).values({ serviceId: other.id, staffId: w.staffId });
    expect(await times({ serviceIds: [other.id] })).toEqual([]);
  });

  test("an unknown service yields nothing", async () => {
    expect(await times({ serviceIds: ["00000000-0000-4000-8000-000000000000"] })).toEqual([]);
  });

  test("a staff member must offer every selected service", async () => {
    const colour = await createService(w.db, w.businessId, { name: "Colour" });
    await offer(w.db, colour.id, w.locationId, (await addStaff(w.db, w.businessId, "Zed")).id);
    // the stylist does not offer Colour
    expect(await times({ serviceIds: [w.haircutId, colour.id] })).toEqual([]);
  });

  test("duplicate service ids are counted once", async () => {
    const [first] = await getAvailableSlots(
      w.db,
      query({ serviceIds: [w.haircutId, w.haircutId] }),
    );
    expect(localTime(first.end)).toBe("09:45");
  });
});

describe("getAvailableSlots: occupied time", () => {
  test("confirmed bookings block overlapping slots but not back-to-back ones", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    const slots = await times();
    expect(slots).toContain("09:15");
    expect(slots).not.toContain("09:30");
    expect(slots).not.toContain("10:30");
    expect(slots).toContain("10:45");
  });

  test("a pending hold blocks the slot only while it is live", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"), {
      status: "pending_payment",
      holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    expect(await times()).not.toContain("10:00");

    // same hold, queried after it lapsed (but before the sweeper ran)
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect(await times({ now: later })).toContain("10:00");
  });

  test("a pending booking without an expiry still blocks", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"), {
      status: "pending_payment",
      holdExpiresAt: null,
    });
    expect(await times()).not.toContain("10:00");
  });

  test.each([
    "cancelled_by_client",
    "cancelled_by_staff",
    "late_cancelled",
    "expired",
    "no_show",
    "completed",
  ] as const)("a %s booking does not block", async (status) => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"), { status });
    expect(await times()).toContain("10:00");
  });

  test("time blocks remove slots, including partial overlaps", async () => {
    await addBlock(w.db, w.staffId, local("2026-11-02T12:10"), local("2026-11-02T12:20"));
    const slots = await times();
    expect(slots).toContain("11:15");
    expect(slots).not.toContain("11:30");
    expect(slots).not.toContain("12:15");
    expect(slots).toContain("12:30");
  });

  test("another staff member's bookings and blocks do not matter", async () => {
    const other = await addStaff(w.db, w.businessId, "Zed");
    await addBlock(w.db, other.id, local("2026-11-02T00:00"), local("2026-11-03T00:00"));
    expect(await times()).toHaveLength(30);
  });

  test("a booking can be excluded so it can be moved onto its own time", async () => {
    const existing = await addBooking(
      w.db,
      w,
      local("2026-11-02T10:00"),
      local("2026-11-02T10:45"),
    );
    const withSelf = await searchAvailability(w.db, query());
    expect(withSelf.slots.map((s) => localTime(s.start))).not.toContain("10:00");
    const without = await searchAvailability(w.db, query(), { excludeBookingId: existing.id });
    expect(without.slots.map((s) => localTime(s.start))).toContain("10:00");
  });

  test("a booking from the previous evening that runs past midnight is respected", async () => {
    await setSettings(w.db, w.businessId, { minNoticeMin: 0 });
    await addBooking(w.db, w, local("2026-11-01T23:30"), local("2026-11-02T09:30"));
    expect((await times())[0]).toBe("09:30");
  });
});

describe("getAvailableSlots: rules", () => {
  test("only the weekdays with rules are bookable, at the configured hours", async () => {
    await w.db.delete(availabilityRule).where(eq(availabilityRule.staffId, w.staffId));
    await w.db.insert(availabilityRule).values({
      staffId: w.staffId,
      locationId: w.locationId,
      weekday: 1, // Monday
      startMinute: 600,
      endMinute: 780,
    });
    const slots = await getAvailableSlots(
      w.db,
      query({ fromDate: "2026-11-02", toDate: "2026-11-08" }),
    );
    expect(slots.every((s) => localTime(s.start) >= "10:00" && localTime(s.end) <= "13:00")).toBe(
      true,
    );
    expect(slots).toHaveLength(10); // one Monday, 10:00-13:00, 45 minutes on a 15 minute grid
  });

  test("rules for a different location do not apply", async () => {
    const [other] = await w.db
      .insert(location)
      .values({ businessId: w.businessId, name: "Southside" })
      .returning();
    await offer(w.db, w.haircutId, other.id, w.staffId).catch(() => undefined);
    expect(await times({ locationId: other.id })).toEqual([]);
  });

  test("validFrom/validTo bound a rule in local dates", async () => {
    await w.db.delete(availabilityRule).where(eq(availabilityRule.staffId, w.staffId));
    await w.db.insert(availabilityRule).values({
      staffId: w.staffId,
      locationId: w.locationId,
      weekday: 1,
      startMinute: 540,
      endMinute: 600,
      validFrom: "2026-11-09",
      validTo: "2026-11-16",
    });
    const slots = await getAvailableSlots(
      w.db,
      query({ fromDate: "2026-11-02", toDate: "2026-11-30", serviceIds: [w.haircutId] }),
    );
    const days = [...new Set(slots.map((s) => s.start.toISOString()))];
    expect(days.length).toBeGreaterThan(0);
    expect(slots.map((s) => localTime(s.start))).toEqual(["09:00", "09:15", "09:00", "09:15"]);
  });
});

describe("getAvailableSlots: limits", () => {
  test("min notice hides slots that start too soon", async () => {
    await setSettings(w.db, w.businessId, { minNoticeMin: 120 });
    const now = local("2026-11-02T08:00");
    expect((await times({ now }))[0]).toBe("10:00");
  });

  test("max advance days limits how far ahead slots are offered", async () => {
    await setSettings(w.db, w.businessId, { minNoticeMin: 0, maxAdvanceDays: 3 });
    const slots = await getAvailableSlots(
      w.db,
      query({ fromDate: "2026-11-02", toDate: "2026-11-30" }),
    );
    const lastDay = slots.at(-1)!.start;
    expect(lastDay.getTime()).toBeLessThan(local("2026-11-05T00:00").getTime());
  });
});

describe("getAvailableSlots: staff selection", () => {
  test("inactive staff are excluded", async () => {
    await w.db.update(staff).set({ active: false }).where(eq(staff.id, w.staffId));
    expect(await times({ staffId: undefined })).toEqual([]);
    expect(await times()).toEqual([]);
  });

  test("first available: one slot per start time, assigned to the free staff member with fewest bookings", async () => {
    const zed = await addStaff(w.db, w.businessId, "Zed");
    await offer(w.db, w.haircutId, w.locationId, zed.id);
    await openEveryDay(w.db, zed.id, w.locationId);
    // Ryan (the stylist) is busy 09:00-10:00, so Zed takes those starts
    await addBooking(w.db, w, local("2026-11-02T09:00"), local("2026-11-02T10:00"));

    const slots = await getAvailableSlots(w.db, query({ staffId: undefined }));
    expect(new Set(slots.map((s) => s.start.getTime())).size).toBe(slots.length); // deduplicated
    expect(slots.find((s) => localTime(s.start) === "09:00")?.staffId).toBe(zed.id);
    // Ryan has one booking that day and Zed none, so Zed also wins where both are free
    expect(slots.find((s) => localTime(s.start) === "10:00")?.staffId).toBe(zed.id);
  });

  test("a specific staff member only gets their own availability", async () => {
    const zed = await addStaff(w.db, w.businessId, "Zed");
    await offer(w.db, w.haircutId, w.locationId, zed.id);
    await openEveryDay(w.db, zed.id, w.locationId, 600, 660);
    const slots = await getAvailableSlots(w.db, query({ staffId: zed.id }));
    expect(slots.every((s) => s.staffId === zed.id)).toBe(true);
    expect(localTime(slots[0].start)).toBe("10:00");
  });

  test("a staff member who does not offer the service has no slots", async () => {
    const zed = await addStaff(w.db, w.businessId, "Zed");
    await openEveryDay(w.db, zed.id, w.locationId);
    expect(await times({ staffId: zed.id })).toEqual([]);
  });
});
