import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { booking, domainEvent } from "@/db/schema";
import {
  BookingStateError,
  HoldExpiredError,
  NotFoundError,
  cancelBooking,
  completeBooking,
  confirmBooking,
  expireHolds,
  markNoShow,
} from "@/server/booking";
import { addBooking, createWorld, local, setSettings, type World } from "../availability/setup";
import { CLIENT, NOW, auditActions, bookingRow, confirmed, eventsOfType, hold } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("confirmBooking", () => {
  test("promotes a live hold to confirmed, clears the hold and emits booking.confirmed", async () => {
    const { bookingId } = await hold(w);
    await confirmBooking(w.db, bookingId, minutes(5));

    const row = await bookingRow(w.db, bookingId);
    expect(row.status).toBe("confirmed");
    expect(row.holdExpiresAt).toBeNull();
    expect(await eventsOfType(w.db, "booking.confirmed")).toEqual([{ bookingId }]);
    expect(await auditActions(w.db, bookingId)).toContain("booking.confirm");
  });

  test("is idempotent: a second confirmation changes nothing and emits no second event", async () => {
    const { bookingId } = await hold(w);
    await confirmBooking(w.db, bookingId, minutes(1));
    await confirmBooking(w.db, bookingId, minutes(2));
    expect(await eventsOfType(w.db, "booking.confirmed")).toHaveLength(1);
  });

  test("refuses a lapsed hold, even before the sweeper has marked it expired", async () => {
    const { bookingId } = await hold(w);
    await expect(confirmBooking(w.db, bookingId, minutes(10))).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
    expect((await bookingRow(w.db, bookingId)).status).toBe("pending_payment");
    expect(await eventsOfType(w.db, "booking.confirmed")).toHaveLength(0);
  });

  test("refuses an expired booking (late payment) with HoldExpiredError", async () => {
    const { bookingId } = await hold(w);
    await expireHolds(w.db, minutes(11));
    await expect(confirmBooking(w.db, bookingId, minutes(12))).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
  });

  test("refuses bookings in any other status", async () => {
    const { bookingId } = await confirmed(w);
    await cancelBooking(w.db, { bookingId, by: "staff", now: NOW });
    await expect(confirmBooking(w.db, bookingId, NOW)).rejects.toBeInstanceOf(BookingStateError);
  });

  test("a pending booking without an expiry can be confirmed", async () => {
    const row = await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"), {
      status: "pending_payment",
      holdExpiresAt: null,
    });
    await confirmBooking(w.db, row.id, NOW);
    expect((await bookingRow(w.db, row.id)).status).toBe("confirmed");
  });

  test("unknown and malformed ids are NotFoundError", async () => {
    await expect(
      confirmBooking(w.db, "00000000-0000-4000-8000-000000000000", NOW),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(confirmBooking(w.db, "nope", NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("expireHolds", () => {
  test("expires only lapsed pending holds and reports how many", async () => {
    const lapsed = await hold(w);
    const live = await hold(w, {
      start: local("2026-11-02T14:00"),
      now: minutes(8),
    });
    const paid = await confirmed(w, { start: local("2026-11-02T16:00") });
    const noExpiry = await addBooking(
      w.db,
      w,
      local("2026-11-02T12:00"),
      local("2026-11-02T12:45"),
      {
        status: "pending_payment",
        holdExpiresAt: null,
      },
    );

    expect(await expireHolds(w.db, minutes(11))).toBe(1);

    expect((await bookingRow(w.db, lapsed.bookingId)).status).toBe("expired");
    expect((await bookingRow(w.db, live.bookingId)).status).toBe("pending_payment");
    expect((await bookingRow(w.db, paid.bookingId)).status).toBe("confirmed");
    expect((await bookingRow(w.db, noExpiry.id)).status).toBe("pending_payment");
    expect(await auditActions(w.db, lapsed.bookingId)).toContain("booking.expire");
  });

  test("returns 0 when nothing has lapsed and is safe to repeat", async () => {
    await hold(w);
    expect(await expireHolds(w.db, minutes(1))).toBe(0);
    expect(await expireHolds(w.db, minutes(20))).toBe(1);
    expect(await expireHolds(w.db, minutes(21))).toBe(0);
  });

  test("an expired hold frees the slot for someone else", async () => {
    const first = await hold(w);
    await expireHolds(w.db, minutes(11));
    const second = await hold(w, {
      client: { ...CLIENT, email: "b@example.com", phone: "0433 111 222" },
      now: minutes(12),
    });
    expect(second.bookingId).not.toBe(first.bookingId);
  });

  test("defaults the clock to now", async () => {
    expect(await expireHolds(w.db)).toBe(0);
  });
});

describe("completeBooking", () => {
  test("completes a confirmed booking and emits booking.completed", async () => {
    const { bookingId } = await confirmed(w);
    await completeBooking(w.db, bookingId, local("2026-11-02T11:00"), "owner:u1");
    expect((await bookingRow(w.db, bookingId)).status).toBe("completed");
    expect(await eventsOfType(w.db, "booking.completed")).toEqual([{ bookingId }]);
    expect(await auditActions(w.db, bookingId)).toContain("booking.complete");
  });

  test("is idempotent for a completed booking", async () => {
    const { bookingId } = await confirmed(w);
    await completeBooking(w.db, bookingId, local("2026-11-02T11:00"));
    await completeBooking(w.db, bookingId, local("2026-11-02T11:05"));
    expect(await eventsOfType(w.db, "booking.completed")).toHaveLength(1);
  });

  test("refuses pending and cancelled bookings", async () => {
    const pending = await hold(w);
    await expect(completeBooking(w.db, pending.bookingId, NOW)).rejects.toBeInstanceOf(
      BookingStateError,
    );
    const other = await confirmed(w, { start: local("2026-11-02T14:00") });
    await cancelBooking(w.db, { bookingId: other.bookingId, by: "staff", now: NOW });
    await expect(completeBooking(w.db, other.bookingId, NOW)).rejects.toBeInstanceOf(
      BookingStateError,
    );
  });

  test("defaults the clock to now", async () => {
    const { bookingId } = await confirmed(w);
    await completeBooking(w.db, bookingId);
    expect((await bookingRow(w.db, bookingId)).status).toBe("completed");
  });
});

describe("markNoShow", () => {
  const AFTER = local("2026-11-02T11:00");

  test("keeps the deposit, stores no_show and emits booking.no_show with the fee", async () => {
    await setSettings(w.db, w.businessId, { extraFeePct: 30 });
    const { bookingId } = await confirmed(w);
    const outcome = await markNoShow(w.db, bookingId, AFTER, "owner:u1");

    expect(outcome).toMatchObject({ bookingId, depositAction: "keep", feeCents: 2850 });
    expect((await bookingRow(w.db, bookingId)).status).toBe("no_show");
    expect(await eventsOfType(w.db, "booking.no_show")).toEqual([{ bookingId, feeCents: 2850 }]);
    expect(await auditActions(w.db, bookingId)).toContain("booking.no_show");
  });

  test("with no extra fee configured the fee is 0", async () => {
    const { bookingId } = await confirmed(w);
    expect((await markNoShow(w.db, bookingId, AFTER)).feeCents).toBe(0);
  });

  test("is allowed from the moment the appointment starts", async () => {
    const { bookingId } = await confirmed(w);
    await markNoShow(w.db, bookingId, local("2026-11-02T10:00"));
    expect((await bookingRow(w.db, bookingId)).status).toBe("no_show");
  });

  test("refuses before the start time", async () => {
    const { bookingId } = await confirmed(w);
    await expect(markNoShow(w.db, bookingId, local("2026-11-02T09:59"))).rejects.toBeInstanceOf(
      BookingStateError,
    );
    expect((await bookingRow(w.db, bookingId)).status).toBe("confirmed");
  });

  test("refuses anything but a confirmed booking", async () => {
    const pending = await hold(w);
    await expect(markNoShow(w.db, pending.bookingId, AFTER)).rejects.toBeInstanceOf(
      BookingStateError,
    );
    const { bookingId } = await confirmed(w, { start: local("2026-11-02T14:00") });
    await markNoShow(w.db, bookingId, local("2026-11-02T15:00"));
    await expect(markNoShow(w.db, bookingId, local("2026-11-02T15:00"))).rejects.toBeInstanceOf(
      BookingStateError,
    );
  });

  test("rolls back completely when the transition is refused", async () => {
    const { bookingId } = await confirmed(w);
    await expect(markNoShow(w.db, bookingId, local("2026-11-02T09:00"))).rejects.toThrow();
    expect(
      await w.db.select().from(domainEvent).where(eq(domainEvent.type, "booking.no_show")),
    ).toHaveLength(0);
    const [row] = await w.db.select().from(booking).where(eq(booking.id, bookingId));
    expect(row.status).toBe("confirmed");
  });
});
