import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { availabilityRule, location, rosterException, staff } from "@/db/schema";
import { getRosterOverview, weekDates, weekStartOf } from "@/server/roster";
import { addLocation, addStylist, createWorld, type World } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("weekStartOf / weekDates", () => {
  test("any day maps to its Monday", () => {
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02");
    expect(weekStartOf("2026-11-04")).toBe("2026-11-02");
    expect(weekStartOf("2026-11-08")).toBe("2026-11-02"); // Sunday belongs to the week before
    expect(weekStartOf("2026-11-09")).toBe("2026-11-09");
  });

  test("an unparseable date falls back to the current week", () => {
    expect(weekStartOf("nonsense")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("gives seven consecutive dates", () => {
    expect(weekDates("2026-11-02")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
  });
});

describe("getRosterOverview", () => {
  test("shows each stylist's weekly hours per day and location", async () => {
    const overview = await getRosterOverview(w.db, { weekOf: "2026-11-04" });
    expect(overview.weekStart).toBe("2026-11-02");
    expect(overview.rows).toHaveLength(1);
    const [row] = overview.rows;
    expect(row.name).toBe("Ryan");
    expect(row.days).toHaveLength(7);
    expect(row.days[0].entries).toEqual([
      {
        locationId: w.locationId,
        locationName: "Northside",
        kind: "weekly",
        ranges: [{ startMinute: 540, endMinute: 1020 }],
      },
    ]);
    expect(row.days[0].off).toBeNull();
  });

  test("applies day off and custom exceptions", async () => {
    await w.db.insert(rosterException).values([
      { staffId: w.staffId, date: "2026-11-02", kind: "off", note: "Dentist" },
      {
        staffId: w.staffId,
        date: "2026-11-03",
        kind: "custom",
        locationId: w.locationId,
        startMinute: 600,
        endMinute: 720,
      },
    ]);
    const [row] = (await getRosterOverview(w.db, { weekOf: "2026-11-02" })).rows;
    expect(row.days[0].entries).toEqual([]);
    expect(row.days[0].off).toEqual({
      note: "Dentist",
      everywhere: true,
      locationNames: ["Northside"],
    });
    expect(row.days[1].entries[0]).toMatchObject({
      kind: "custom",
      ranges: [{ startMinute: 600, endMinute: 720 }],
    });
  });

  test("a day off at one location leaves the other location's hours", async () => {
    const south = await addLocation(w.db, w.businessId, "Southside");
    await w.db.insert(availabilityRule).values({
      staffId: w.staffId,
      locationId: south.id,
      weekday: 1,
      startMinute: 600,
      endMinute: 780,
    });
    await w.db
      .insert(rosterException)
      .values({ staffId: w.staffId, date: "2026-11-02", kind: "off", locationId: w.locationId });
    const overview = await getRosterOverview(w.db, { weekOf: "2026-11-02" });
    const day = overview.rows[0].days[0];
    expect(day.entries.map((e) => e.locationName)).toEqual(["Southside"]);
    expect(day.off).toMatchObject({ everywhere: false, locationNames: ["Northside"] });
    expect(overview.locations.map((l) => l.name)).toEqual(["Northside", "Southside"]);
  });

  test("lists stylists alphabetically and skips inactive ones and closed locations", async () => {
    await addStylist(w.db, w, "Amy");
    const gone = await addStylist(w.db, w, "Bea");
    await w.db.update(staff).set({ active: false }).where(eq(staff.id, gone.id));
    const closed = await addLocation(w.db, w.businessId, "Closed");
    await w.db.update(location).set({ active: false }).where(eq(location.id, closed.id));

    const overview = await getRosterOverview(w.db, { weekOf: "2026-11-02" });
    expect(overview.rows.map((r) => r.name)).toEqual(["Amy", "Ryan"]);
    expect(overview.locations.map((l) => l.name)).toEqual(["Northside"]);
  });

  test("can be limited to given stylists (a stylist sees only their own)", async () => {
    const amy = await addStylist(w.db, w, "Amy");
    const own = await getRosterOverview(w.db, { weekOf: "2026-11-02", staffIds: [amy.id] });
    expect(own.rows.map((r) => r.name)).toEqual(["Amy"]);
    const none = await getRosterOverview(w.db, { weekOf: "2026-11-02", staffIds: [] });
    expect(none.rows).toEqual([]);
  });

  test("honours date-bounded weekly rules", async () => {
    await w.db.delete(availabilityRule);
    await w.db.insert(availabilityRule).values({
      staffId: w.staffId,
      locationId: w.locationId,
      weekday: 1,
      startMinute: 540,
      endMinute: 600,
      validFrom: "2026-11-09",
    });
    const first = await getRosterOverview(w.db, { weekOf: "2026-11-02" });
    expect(first.rows[0].days[0].entries).toEqual([]);
    const second = await getRosterOverview(w.db, { weekOf: "2026-11-09" });
    expect(second.rows[0].days[0].entries).toHaveLength(1);
  });
});
