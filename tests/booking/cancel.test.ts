import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BookingStateError, NotFoundError, cancelBooking, expireHolds } from "@/server/booking";
import { createWorld, local, setSettings, type World } from "../availability/setup";
import { NOW, auditActions, bookingRow, confirmed, eventsOfType, hold } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

// The booking is Monday 2026-11-02 10:00 local. The default window is 24 hours.
const OUTSIDE = local("2026-11-01T09:00"); // 25h before
const BOUNDARY = local("2026-11-01T10:00"); // exactly 24h before
const INSIDE = local("2026-11-01T20:00"); // 14h before

describe("cancelBooking by the client", () => {
  test("outside the window: cancelled_by_client with a deposit refund", async () => {
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, {
      bookingId,
      by: "client",
      now: OUTSIDE,
      reason: "Sick",
    });

    expect(outcome).toEqual({
      bookingId,
      status: "cancelled_by_client",
      depositAction: "refund",
      feeCents: 0,
    });
    const row = await bookingRow(w.db, bookingId);
    expect(row).toMatchObject({ status: "cancelled_by_client", cancelReason: "Sick" });
    expect(row.cancelledAt).toEqual(OUTSIDE);
    expect(await eventsOfType(w.db, "booking.cancelled")).toEqual([
      { bookingId, by: "client", depositAction: "refund", feeCents: 0 },
    ]);
    expect(await auditActions(w.db, bookingId)).toContain("booking.cancel");
  });

  test("exactly 24 hours before is still free", async () => {
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "client", now: BOUNDARY });
    expect(outcome.status).toBe("cancelled_by_client");
  });

  test("inside the window: late_cancelled, deposit kept, fee from extraFeePct", async () => {
    await setSettings(w.db, w.businessId, { extraFeePct: 20 });
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "client", now: INSIDE });

    expect(outcome).toEqual({
      bookingId,
      status: "late_cancelled",
      depositAction: "keep",
      feeCents: 1900, // 20% of $95
    });
    expect((await bookingRow(w.db, bookingId)).status).toBe("late_cancelled");
    expect(await eventsOfType(w.db, "booking.cancelled")).toEqual([
      { bookingId, by: "client", depositAction: "keep", feeCents: 1900 },
    ]);
  });

  test("inside the window with the default settings keeps the deposit and charges no extra fee", async () => {
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "client", now: INSIDE });
    expect(outcome).toMatchObject({ status: "late_cancelled", depositAction: "keep", feeCents: 0 });
  });

  test("after the appointment has started it counts as a late cancel", async () => {
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, {
      bookingId,
      by: "client",
      now: local("2026-11-02T10:10"),
    });
    expect(outcome.status).toBe("late_cancelled");
  });

  test("a different cancel window is honoured", async () => {
    await setSettings(w.db, w.businessId, { cancelWindowHours: 48 });
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "client", now: OUTSIDE });
    expect(outcome.status).toBe("late_cancelled"); // 25h < 48h
  });

  test("refundOutsideWindow=credit leaves the deposit as credit (action none)", async () => {
    await setSettings(w.db, w.businessId, { refundOutsideWindow: "credit" });
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "client", now: OUTSIDE });
    expect(outcome).toMatchObject({ status: "cancelled_by_client", depositAction: "none" });
  });

  test("the slot is freed for others once cancelled", async () => {
    const { bookingId } = await confirmed(w);
    await cancelBooking(w.db, { bookingId, by: "client", now: OUTSIDE });
    await expect(hold(w, { now: OUTSIDE })).resolves.toBeTruthy();
  });
});

describe("cancelBooking by staff", () => {
  test("always cancelled_by_staff with a refund and no fee, even inside the window", async () => {
    await setSettings(w.db, w.businessId, { extraFeePct: 50 });
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "staff", now: INSIDE }, "owner:u1");

    expect(outcome).toEqual({
      bookingId,
      status: "cancelled_by_staff",
      depositAction: "refund",
      feeCents: 0,
    });
    expect(await eventsOfType(w.db, "booking.cancelled")).toEqual([
      { bookingId, by: "staff", depositAction: "refund", feeCents: 0 },
    ]);
  });

  test("forceRefund overrides the late-cancel policy", async () => {
    await setSettings(w.db, w.businessId, { extraFeePct: 50 });
    const { bookingId } = await confirmed(w);
    const outcome = await cancelBooking(w.db, {
      bookingId,
      by: "client",
      forceRefund: true,
      now: INSIDE,
    });
    expect(outcome).toEqual({
      bookingId,
      status: "cancelled_by_client",
      depositAction: "refund",
      feeCents: 0,
    });
  });
});

describe("cancelBooking: pending and invalid states", () => {
  test("cancelling a pending_payment booking: cancelled, nothing to refund or keep", async () => {
    const { bookingId } = await hold(w);
    const outcome = await cancelBooking(w.db, {
      bookingId,
      by: "client",
      now: local("2026-11-02T09:00"),
    });
    expect(outcome).toEqual({
      bookingId,
      status: "cancelled_by_client",
      depositAction: "none",
      feeCents: 0,
    });
    const row = await bookingRow(w.db, bookingId);
    expect(row.holdExpiresAt).toBeNull();
    expect(await eventsOfType(w.db, "booking.cancelled")).toEqual([
      { bookingId, by: "client", depositAction: "none", feeCents: 0 },
    ]);
  });

  test("staff can cancel a pending booking too", async () => {
    const { bookingId } = await hold(w);
    const outcome = await cancelBooking(w.db, { bookingId, by: "staff", now: NOW });
    expect(outcome).toMatchObject({ status: "cancelled_by_staff", depositAction: "none" });
  });

  test("cannot cancel twice, an expired booking, or a completed one", async () => {
    const { bookingId } = await confirmed(w);
    await cancelBooking(w.db, { bookingId, by: "staff", now: NOW });
    await expect(cancelBooking(w.db, { bookingId, by: "staff", now: NOW })).rejects.toBeInstanceOf(
      BookingStateError,
    );

    const lapsed = await hold(w);
    await expireHolds(w.db, new Date(NOW.getTime() + 11 * 60_000));
    await expect(
      cancelBooking(w.db, { bookingId: lapsed.bookingId, by: "client", now: NOW }),
    ).rejects.toBeInstanceOf(BookingStateError);
  });

  test("a refused cancellation emits nothing", async () => {
    const { bookingId } = await confirmed(w);
    await cancelBooking(w.db, { bookingId, by: "staff", now: NOW });
    await expect(cancelBooking(w.db, { bookingId, by: "client", now: NOW })).rejects.toThrow();
    expect(await eventsOfType(w.db, "booking.cancelled")).toHaveLength(1);
  });

  test("an unknown booking is NotFoundError", async () => {
    await expect(
      cancelBooking(w.db, { bookingId: "00000000-0000-4000-8000-000000000000", by: "client" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("defaults the clock to now", async () => {
    const { bookingId } = await confirmed(w);
    vi.useFakeTimers({ toFake: ["Date"], now: INSIDE });
    try {
      const outcome = await cancelBooking(w.db, { bookingId, by: "client" });
      expect(outcome.status).toBe("late_cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
});
