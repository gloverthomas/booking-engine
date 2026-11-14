import { describe, expect, it, vi } from "vitest";
import {
  handleBookingIcs,
  handleCancelBooking,
  handleGetBooking,
  handleRescheduleBooking,
} from "@/lib/public-api-handlers-booking";
import { BOOKING_ID, LOC, SVC_CUT, TOKEN, get, makeBackend, makeDeps, post } from "./fakes";
import type { PublicBookingSummary } from "@/server/contracts";

async function json(res: Response) {
  return (await res.json()) as {
    success: boolean;
    data?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    error?: { code: string; message: string };
  };
}

const summary = (over: Partial<PublicBookingSummary> = {}): PublicBookingSummary => ({
  bookingId: BOOKING_ID,
  status: "confirmed",
  start: new Date("2026-11-20T03:30:00Z"),
  end: new Date("2026-11-20T04:15:00Z"),
  locationName: "Northside",
  services: [{ name: "Maintenance Haircut", priceCents: 9500 }],
  totalCents: 9500,
  depositCents: 4750,
  ...over,
});

const url = "http://localhost/api/public/bookings/x";

describe("GET /bookings/[token]", () => {
  it("returns the booking, location context and the cancellation outcome", async () => {
    const res = await handleGetBooking(makeDeps(), get(url), TOKEN);
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({
      booking: { bookingId: BOOKING_ID, status: "confirmed", depositCents: 4750 },
      location: { id: LOC, address: expect.stringContaining("Rathdowne") },
      serviceIds: [SVC_CUT],
      businessName: "Ryan Kennedy Hairdressing",
      timezone: "Australia/Melbourne",
      cancellation: { canCancel: true, canReschedule: true, depositOutcome: "refund" },
    });
  });

  it.each([
    ["an empty token", ""],
    ["a forged token", "forged.token"],
    ["an oversized token", "a".repeat(300)],
  ])("404s for %s", async (_name, token) => {
    const res = await handleGetBooking(makeDeps(), get(url), token);
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("not_found");
  });

  it("404s when the backend does not know the booking or ids disagree", async () => {
    const none = makeDeps({
      backend: makeBackend({ getBookingByToken: vi.fn(async () => null) }),
    });
    expect((await handleGetBooking(none, get(url), TOKEN)).status).toBe(404);

    const mismatch = makeDeps({
      backend: makeBackend({
        getBookingByToken: vi.fn(async () => summary({ bookingId: "other" })),
      }),
    });
    expect((await handleGetBooking(mismatch, get(url), TOKEN)).status).toBe(404);

    const noContext = makeDeps({ loadBookingContext: async () => null });
    expect((await handleGetBooking(noContext, get(url), TOKEN)).status).toBe(404);
  });
});

describe("POST /bookings/[token]/cancel", () => {
  it("cancels outside the window and explains the refund", async () => {
    const backend = makeBackend();
    const res = await handleCancelBooking(
      makeDeps({ backend }),
      post({ reason: " moving " }),
      TOKEN,
    );
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({ status: "cancelled_by_client", depositAction: "refund" });
    expect(data?.message).toContain("$47.50");
    expect(backend.cancelBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID, by: "client", reason: "moving" }),
    );
  });

  it("works with an empty body and reports a forfeited deposit", async () => {
    const backend = makeBackend({
      cancelBooking: vi.fn(async () => ({
        bookingId: BOOKING_ID,
        status: "late_cancelled" as const,
        depositAction: "keep" as const,
        feeCents: 0,
      })),
    });
    const deps = makeDeps({
      backend,
      now: () => new Date("2026-11-19T10:00:00Z"),
    });
    const res = await handleCancelBooking(
      deps,
      new Request("http://x/", { method: "POST" }),
      TOKEN,
    );
    const { data } = await json(res);
    expect(data).toMatchObject({ status: "late_cancelled", depositAction: "keep" });
    expect(data?.message).toContain("isn't refunded");
  });

  it("refuses when the booking can no longer be cancelled", async () => {
    const deps = makeDeps({
      backend: makeBackend({
        getBookingByToken: vi.fn(async () => summary({ status: "completed" })),
      }),
    });
    const res = await handleCancelBooking(deps, post({}), TOKEN);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toContain("complete");
  });

  it("maps domain failures", async () => {
    const backend = makeBackend({
      cancelBooking: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "invalid_state" });
      }),
    });
    const res = await handleCancelBooking(makeDeps({ backend }), post({}), TOKEN);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("invalid_state");
  });

  it("404s for a bad token and is rate limited", async () => {
    const deps = makeDeps();
    expect((await handleCancelBooking(deps, post({}), "bad")).status).toBe(404);
    let last = 0;
    for (let i = 0; i < 20; i++) last = (await handleCancelBooking(deps, post({}), "bad")).status;
    expect(last).toBe(429);
  });
});

describe("POST /bookings/[token]/reschedule", () => {
  const body = { start: "2026-11-21T03:30:00Z" };

  it("moves the booking and keeps the duration", async () => {
    const backend = makeBackend();
    const res = await handleRescheduleBooking(makeDeps({ backend }), post(body), TOKEN);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      start: "2026-11-21T03:30:00.000Z",
      end: "2026-11-21T04:15:00.000Z",
    });
    expect(backend.rescheduleBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: BOOKING_ID,
        newStart: new Date("2026-11-21T03:30:00Z"),
        by: "client",
        notifyClient: true,
      }),
    );
  });

  it("refuses inside the window with the policy reason", async () => {
    const deps = makeDeps({ now: () => new Date("2026-11-19T10:00:00Z") });
    const res = await handleRescheduleBooking(deps, post(body), TOKEN);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toContain("24 hours");
  });

  it("rejects past times, bad bodies and domain conflicts", async () => {
    const past = await handleRescheduleBooking(
      makeDeps(),
      post({ start: "2026-11-13T03:30:00Z" }),
      TOKEN,
    );
    expect(past.status).toBe(409);

    const bad = await handleRescheduleBooking(makeDeps(), post({ start: "soon" }), TOKEN);
    expect(bad.status).toBe(422);

    const backend = makeBackend({
      rescheduleBooking: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "slot_taken" });
      }),
    });
    const taken = await handleRescheduleBooking(makeDeps({ backend }), post(body), TOKEN);
    expect((await json(taken)).error?.code).toBe("slot_taken");
  });
});

describe("GET /bookings/[token]/ics", () => {
  it("serves a calendar file for a confirmed booking", async () => {
    const res = await handleBookingIcs(makeDeps(), get(url), TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("content-disposition")).toContain("appointment.ics");
    const text = await res.text();
    expect(text).toContain("DTSTART:20261120T033000Z");
    expect(text).toContain("Maintenance Haircut with Ryan Kennedy Hairdressing");
    expect(text).toContain("LOCATION:Northside\\, 302 Rathdowne Street");
  });

  it("404s for bookings that are not confirmed", async () => {
    const deps = makeDeps({
      backend: makeBackend({
        getBookingByToken: vi.fn(async () => summary({ status: "pending_payment" })),
      }),
    });
    expect((await handleBookingIcs(deps, get(url), TOKEN)).status).toBe(404);
  });
});
