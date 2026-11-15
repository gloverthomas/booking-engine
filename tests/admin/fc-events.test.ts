import { describe, expect, test } from "vitest";
import { locationSlot, toFullCalendarEvent } from "@/components/admin/calendar/fc-events";
import type { CalendarEvent } from "@/server/admin/types";

const TZ = "Australia/Melbourne";
const locations = ["loc-a", "loc-b"];

const booking = (
  over: Partial<Extract<CalendarEvent, { kind: "booking" }>> = {},
): CalendarEvent => ({
  kind: "booking",
  id: "b1",
  start: "2026-11-14T00:00:00.000Z",
  end: "2026-11-14T00:45:00.000Z",
  staffId: "s1",
  locationId: "loc-b",
  status: "confirmed",
  clientId: "c1",
  clientName: "Sam Client",
  services: ["Cut"],
  totalCents: 9500,
  source: "online",
  ...over,
});

describe("toFullCalendarEvent", () => {
  test("shows bookings on the Melbourne wall clock with location and status classes", () => {
    const fc = toFullCalendarEvent(booking(), TZ, locations);
    expect((fc.start as Date).toISOString()).toBe("2026-11-14T11:00:00.000Z");
    expect((fc.end as Date).toISOString()).toBe("2026-11-14T11:45:00.000Z");
    expect(fc.title).toBe("Sam Client");
    expect(fc.classNames).toEqual(["cal-ev", "cal-loc-1", "cal-status-confirmed"]);
    expect(fc.editable).toBe(true);
  });

  test("only live bookings can be dragged", () => {
    expect(
      toFullCalendarEvent(booking({ status: "pending_payment" }), TZ, locations).editable,
    ).toBe(true);
    expect(toFullCalendarEvent(booking({ status: "completed" }), TZ, locations).editable).toBe(
      false,
    );
    expect(toFullCalendarEvent(booking({ status: "no_show" }), TZ, locations).editable).toBe(false);
  });

  test("blocks and Google time are muted and never draggable", () => {
    const block = toFullCalendarEvent(
      {
        kind: "block",
        id: "k1",
        start: "2026-11-14T00:00:00.000Z",
        end: "2026-11-14T01:00:00.000Z",
        staffId: "s1",
        reason: "Lunch",
      },
      TZ,
      locations,
    );
    expect(block).toMatchObject({
      id: "block:k1",
      title: "Lunch",
      editable: false,
      classNames: ["cal-block"],
    });

    const external = toFullCalendarEvent(
      {
        kind: "external",
        id: "g1",
        start: "2026-11-14T00:00:00.000Z",
        end: "2026-11-14T01:00:00.000Z",
        staffId: "s1",
        reason: null,
      },
      TZ,
      locations,
    );
    expect(external).toMatchObject({
      id: "external:g1",
      title: "Busy (Google Calendar)",
      classNames: ["cal-external"],
    });
  });

  test("unknown locations fall back to the first slot and slots wrap", () => {
    expect(locationSlot(locations, "nope")).toBe(0);
    const many = Array.from({ length: 8 }, (_, i) => `l${i}`);
    expect(locationSlot(many, "l7")).toBe(1);
  });

  test("bookings take their stylist's colour with readable text, status stays a class", () => {
    const staff = new Map([
      ["s1", { name: "Alex", colour: "#fde68a" }],
      ["s2", { name: "Blake", colour: "#0f5c5c" }],
    ]);
    const light = toFullCalendarEvent(booking({ status: "pending_payment" }), TZ, locations, staff);
    expect(light).toMatchObject({
      backgroundColor: "#fde68a",
      textColor: "#1c1917",
      extendedProps: { staffName: "Alex", staffColour: "#fde68a", status: "pending_payment" },
    });
    expect(light.classNames).toContain("cal-status-pending_payment");
    const dark = toFullCalendarEvent(booking({ staffId: "s2" }), TZ, locations, staff);
    expect(dark).toMatchObject({ backgroundColor: "#0f5c5c", textColor: "#ffffff" });
  });

  test("a single stylist or one location adds no names or location stripe", () => {
    const solo = new Map([["s1", { name: "Alex", colour: "#0f5c5c" }]]);
    const fc = toFullCalendarEvent(booking(), TZ, ["loc-a"], solo);
    expect(fc.extendedProps).toMatchObject({ staffName: null });
    expect(fc.classNames).toEqual(["cal-ev", "cal-status-confirmed"]);
  });

  test("a stylist who has left falls back to neutral grey", () => {
    const staff = new Map([["s2", { name: "Blake", colour: "#0f5c5c" }]]);
    const fc = toFullCalendarEvent(booking(), TZ, locations, staff);
    expect(fc.backgroundColor).toBe("#57534e");
  });

  test("blocks carry the stylist's colour on their edge and their name once there are several", () => {
    const staff = new Map([
      ["s1", { name: "Alex", colour: "#2f4b8c" }],
      ["s2", { name: "Blake", colour: "#0f5c5c" }],
    ]);
    const fc = toFullCalendarEvent(
      {
        kind: "block",
        id: "k1",
        start: "2026-11-14T00:00:00.000Z",
        end: "2026-11-14T01:00:00.000Z",
        staffId: "s1",
        reason: "Lunch",
      },
      TZ,
      locations,
      staff,
    );
    expect(fc).toMatchObject({ title: "Lunch · Alex", borderColor: "#2f4b8c" });
  });
});
