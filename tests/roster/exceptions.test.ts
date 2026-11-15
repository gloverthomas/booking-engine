import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { auditLog, rosterException } from "@/db/schema";
import { getAvailableSlots } from "@/server/availability";
import { AdminError } from "@/server/admin-foundation/errors";
import {
  listExceptions,
  removeException,
  setCustomHours,
  setDayOff,
} from "@/server/roster";
import { MONDAY, NOW, addBooking, local, localTime } from "../availability/setup";
import { TODAY, addLocation, addStylist, createWorld, type World } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld({ minNoticeMin: 0 });
});
afterEach(async () => {
  await w.t.client.close();
});

const actor = "owner:user-1" as const;
const dayOff = (overrides: Partial<Parameters<typeof setDayOff>[2]> = {}) =>
  setDayOff(
    w.db,
    actor,
    { staffId: w.staffId, date: MONDAY, locationId: null, note: null, ...overrides },
    TODAY,
  );
const custom = (overrides: Partial<Parameters<typeof setCustomHours>[2]> = {}) =>
  setCustomHours(
    w.db,
    actor,
    {
      staffId: w.staffId,
      date: MONDAY,
      locationId: w.locationId,
      ranges: [{ startMinute: 600, endMinute: 720 }],
      note: null,
      ...overrides,
    },
    TODAY,
  );

const slotTimes = async () =>
  (
    await getAvailableSlots(w.db, {
      locationId: w.locationId,
      staffId: w.staffId,
      serviceIds: [w.haircutId],
      fromDate: MONDAY,
      toDate: MONDAY,
      now: NOW,
    })
  ).map((s) => localTime(s.start));

async function auditActionsFor(action: string) {
  const rows = await w.db.select().from(auditLog).where(eq(auditLog.action, action));
  return rows;
}

describe("setDayOff", () => {
  test("stores the exception, removes the day's availability and audits it", async () => {
    const result = await dayOff({ note: "Dentist" });
    expect(result.ids).toHaveLength(1);
    expect(result.conflictingBookings).toBe(0);
    expect(await slotTimes()).toEqual([]);

    const [row] = await w.db.select().from(rosterException);
    expect(row).toMatchObject({ kind: "off", date: MONDAY, locationId: null, note: "Dentist" });
    const [audit] = await auditActionsFor("roster.day_off");
    expect(audit.actor).toBe(actor);
    expect(audit.data).toMatchObject({ staffId: w.staffId, date: MONDAY });
  });

  test("replaces an earlier setting for the same stylist, date and scope", async () => {
    await dayOff({ note: "first" });
    await dayOff({ note: "second" });
    const rows = await w.db.select().from(rosterException);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("second");
  });

  test("a location-scoped day off is a separate scope from an everywhere one", async () => {
    await dayOff({ locationId: null });
    await dayOff({ locationId: w.locationId });
    expect(await w.db.select().from(rosterException)).toHaveLength(2);
  });

  test("reports existing bookings that fall on the day off, without blocking", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    await addBooking(w.db, w, local("2026-11-02T11:00"), local("2026-11-02T11:45"));
    await addBooking(w.db, w, local("2026-11-03T11:00"), local("2026-11-03T11:45"));
    expect((await dayOff()).conflictingBookings).toBe(2);
  });

  test("a day off at one location ignores bookings at another", async () => {
    const other = await addLocation(w.db, w.businessId, "Southside");
    await addBooking(
      w.db,
      { ...w, locationId: other.id },
      local("2026-11-02T10:00"),
      local("2026-11-02T10:45"),
    );
    expect((await dayOff({ locationId: w.locationId })).conflictingBookings).toBe(0);
    expect((await dayOff({ locationId: other.id })).conflictingBookings).toBe(1);
  });

  test("allows today but not a past date", async () => {
    await expect(dayOff({ date: "2026-11-01" })).resolves.toBeDefined();
    await expect(dayOff({ date: "2026-10-31" })).rejects.toMatchObject({ code: "past_date" });
  });

  test("unknown stylist or location is not found", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(dayOff({ staffId: missing })).rejects.toBeInstanceOf(AdminError);
    await expect(dayOff({ locationId: missing })).rejects.toMatchObject({ code: "not_found" });
  });

  test("defaults the clock to now", async () => {
    await expect(
      setDayOff(w.db, actor, {
        staffId: w.staffId,
        date: "2999-01-01",
        locationId: null,
        note: null,
      }),
    ).resolves.toBeDefined();
  });
});

describe("setCustomHours", () => {
  test("replaces the day's hours with the given ranges", async () => {
    await custom({ ranges: [{ startMinute: 600, endMinute: 720 }] });
    const times = await slotTimes();
    expect(times[0]).toBe("10:00");
    expect(times.at(-1)).toBe("11:15");
    const [audit] = await auditActionsFor("roster.custom_hours");
    expect(audit.actor).toBe(actor);
  });

  test("supports a split day (several ranges)", async () => {
    const result = await custom({
      ranges: [
        { startMinute: 540, endMinute: 600 },
        { startMinute: 840, endMinute: 900 },
      ],
    });
    expect(result.ids).toHaveLength(2);
    const times = await slotTimes();
    expect(times).toContain("09:00");
    expect(times).toContain("14:00");
    expect(times).not.toContain("12:00");
  });

  test("setting again replaces the earlier custom rows", async () => {
    await custom({
      ranges: [
        { startMinute: 540, endMinute: 600 },
        { startMinute: 840, endMinute: 900 },
      ],
    });
    await custom({ ranges: [{ startMinute: 600, endMinute: 660 }] });
    expect(await w.db.select().from(rosterException)).toHaveLength(1);
  });

  test("keeps the note on every row", async () => {
    await custom({ note: "Late start" });
    const [row] = await w.db.select().from(rosterException);
    expect(row.note).toBe("Late start");
  });

  test("rejects overlapping, backwards or out of range hours", async () => {
    await expect(
      custom({
        ranges: [
          { startMinute: 540, endMinute: 700 },
          { startMinute: 600, endMinute: 720 },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_hours" });
    await expect(custom({ ranges: [{ startMinute: 700, endMinute: 600 }] })).rejects.toMatchObject(
      { code: "invalid_hours" },
    );
    expect(await w.db.select().from(rosterException)).toHaveLength(0);
  });

  test("rejects a past date, an unknown stylist and an unknown location", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(custom({ date: "2026-10-01" })).rejects.toMatchObject({ code: "past_date" });
    await expect(custom({ staffId: missing })).rejects.toMatchObject({ code: "not_found" });
    await expect(custom({ locationId: missing })).rejects.toMatchObject({ code: "not_found" });
  });

  test("counts bookings that now sit outside the new hours", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45")); // inside
    await addBooking(w.db, w, local("2026-11-02T13:00"), local("2026-11-02T13:45")); // outside
    expect((await custom()).conflictingBookings).toBe(1);
  });

  test("works for a second stylist independently", async () => {
    const zed = await addStylist(w.db, w, "Zed");
    await custom({ staffId: zed.id });
    const rows = await w.db.select().from(rosterException);
    expect(rows.map((r) => r.staffId)).toEqual([zed.id]);
  });
});

describe("removeException and listExceptions", () => {
  test("removes one exception so the weekly hours apply again, and audits it", async () => {
    const { ids } = await dayOff();
    expect(await slotTimes()).toEqual([]);
    await removeException(w.db, actor, ids[0]);
    expect((await slotTimes()).length).toBe(30);
    expect((await auditActionsFor("roster.exception_removed"))[0].actor).toBe(actor);
  });

  test("removing something that is gone is a not-found error", async () => {
    await expect(
      removeException(w.db, actor, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("lists upcoming exceptions soonest first with names, scoped when asked", async () => {
    const zed = await addStylist(w.db, w, "Zed");
    await dayOff({ date: "2026-11-09", note: "later" });
    await dayOff({ date: "2026-11-02" });
    await dayOff({ staffId: zed.id, date: "2026-11-02", locationId: w.locationId });
    await w.db.insert(rosterException).values({
      staffId: w.staffId,
      date: "2026-10-01",
      kind: "off",
    });

    const all = await listExceptions(w.db, { fromDate: "2026-11-01" });
    expect(all.map((e) => [e.date, e.staffName])).toEqual([
      ["2026-11-02", "Ryan"],
      ["2026-11-02", "Zed"],
      ["2026-11-09", "Ryan"],
    ]);
    expect(all[0].locationName).toBeNull();
    expect(all[1].locationName).toBe("Northside");

    const own = await listExceptions(w.db, { fromDate: "2026-11-01", staffIds: [zed.id] });
    expect(own).toHaveLength(1);
    expect(await listExceptions(w.db, { fromDate: "2026-11-01", staffIds: [] })).toEqual([]);
  });
});
