import { describe, expect, test } from "vitest";
import {
  buildBookingEvent,
  classifyEvent,
  deterministicEventId,
} from "@/server/integrations/google/event-mapper";
import type { BookingBundle } from "@/server/integrations/common/booking-data";
import { busyEvent } from "./helpers";

const TZ = "Australia/Melbourne";

describe("deterministicEventId", () => {
  test("is 32 lowercase hex chars (valid Google base32hex) and stable", () => {
    const id = deterministicEventId("3F2504E0-4F89-11D3-9A0C-0305E82C3301");
    expect(id).toBe("3f2504e04f8911d39a0c0305e82c3301");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("buildBookingEvent", () => {
  const bundle = {
    booking: {
      id: "b-1",
      comments: "Running late maybe",
      during: {
        start: new Date("2026-11-19T23:00:00.000Z"),
        end: new Date("2026-11-20T00:30:00.000Z"),
      },
    },
    client: { firstName: "Sam", lastName: "Client", phone: "+61410123456" },
    location: {
      name: "Northside",
      addressLine: "1 High St",
      suburb: "Northcote",
      state: "VIC",
      postcode: "3070",
    },
    services: [
      { name: "Haircut", durationMin: 45 },
      { name: "Beard trim", durationMin: 15 },
    ],
  } as unknown as BookingBundle;

  test("title, location, phone and admin link; end excludes the buffer", () => {
    const event = buildBookingEvent({ bundle, appUrl: "https://book.example.com", timeZone: TZ });
    expect(event.summary).toBe("Sam Client - Haircut, Beard trim");
    expect(event.location).toBe("Northside, 1 High St, Northcote VIC 3070");
    expect(event.description).toContain("Phone: +61410123456");
    expect(event.description).toContain("https://book.example.com/bookings/b-1");
    expect(event.description).toContain("Running late maybe");
    expect(event.end.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(event.privateProps).toEqual({ bookingId: "b-1", source: "booking-engine" });
  });

  test("falls back to the booking range when no service durations exist", () => {
    const bare = { ...bundle, services: [] } as unknown as BookingBundle;
    const event = buildBookingEvent({ bundle: bare, appUrl: "https://x.test", timeZone: TZ });
    expect(event.summary).toBe("Sam Client");
    expect(event.end.toISOString()).toBe("2026-11-20T00:30:00.000Z");
  });
});

describe("classifyEvent", () => {
  test("a timed busy event becomes a block", () => {
    const decision = classifyEvent(
      busyEvent("e1", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z"),
      TZ,
    );
    expect(decision).toMatchObject({ action: "upsert", reason: "Dentist" });
  });

  test("events we created are skipped", () => {
    const event = busyEvent("e1", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z", {
      extendedProperties: { private: { source: "booking-engine", bookingId: "b" } },
    });
    expect(classifyEvent(event, TZ)).toEqual({ action: "skip" });
  });

  test.each([
    ["cancelled", { status: "cancelled" }],
    ["transparent (free)", { transparency: "transparent" }],
    ["declined by me", { attendees: [{ self: true, responseStatus: "declined" }] }],
    ["birthday", { eventType: "birthday" }],
  ])("%s events delete any existing block", (_name, extra) => {
    const decision = classifyEvent(
      busyEvent("e1", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z", extra),
      TZ,
    );
    expect(decision).toEqual({ action: "delete" });
  });

  test("a declined event for someone else (not self) still blocks", () => {
    const decision = classifyEvent(
      busyEvent("e1", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z", {
        attendees: [{ self: false, responseStatus: "declined" }],
      }),
      TZ,
    );
    expect(decision.action).toBe("upsert");
  });

  test("an all-day event blocks the whole local day (Melbourne, DST aware)", () => {
    const decision = classifyEvent(
      {
        id: "d1",
        summary: "Holiday",
        start: { date: "2026-11-20" },
        end: { date: "2026-11-21" },
      },
      TZ,
    );
    // Melbourne is UTC+11 in November.
    expect(decision).toEqual({
      action: "upsert",
      start: new Date("2026-11-19T13:00:00.000Z"),
      end: new Date("2026-11-20T13:00:00.000Z"),
      reason: "Holiday",
    });
  });

  test("a multi-day all-day event covers every day; missing end defaults to one day", () => {
    const multi = classifyEvent(
      { id: "d2", start: { date: "2026-11-20" }, end: { date: "2026-11-23" } },
      TZ,
    );
    expect(multi).toMatchObject({
      action: "upsert",
      start: new Date("2026-11-19T13:00:00.000Z"),
      end: new Date("2026-11-22T13:00:00.000Z"),
      reason: "Busy (Google Calendar)",
    });
    const noEnd = classifyEvent({ id: "d3", start: { date: "2026-11-20" } }, TZ);
    expect(noEnd).toMatchObject({ action: "upsert", end: new Date("2026-11-20T13:00:00.000Z") });
  });

  test("zero-length, inverted or unparseable events delete; events with no times skip", () => {
    expect(
      classifyEvent(busyEvent("z", "2026-11-20T01:00:00Z", "2026-11-20T01:00:00Z"), TZ),
    ).toEqual({ action: "delete" });
    expect(
      classifyEvent(busyEvent("z", "2026-11-20T03:00:00Z", "2026-11-20T01:00:00Z"), TZ),
    ).toEqual({ action: "delete" });
    expect(classifyEvent(busyEvent("z", "nonsense", "2026-11-20T01:00:00Z"), TZ)).toEqual({
      action: "delete",
    });
    expect(classifyEvent({ id: "n" }, TZ)).toEqual({ action: "skip" });
    expect(
      classifyEvent({ id: "bad", start: { date: "not-a-date" }, end: { date: "x" } }, TZ),
    ).toEqual({ action: "delete" });
  });
});
