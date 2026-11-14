import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bookingService, service } from "@/db/schema";
import {
  BookingStateError,
  ChangeWindowError,
  SlotTakenError,
  ValidationError,
  cancelBooking,
  rescheduleBooking,
} from "@/server/booking";
import { addBlock, addBooking, createWorld, local, type World } from "../availability/setup";
import { NOW, auditActions, bookingRow, confirmed, eventsOfType, hold } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

// Booking under test: Monday 2026-11-02 10:00-10:45. 24 hour window.
const OUTSIDE = local("2026-11-01T09:00");
const INSIDE = local("2026-11-01T20:00");
const ORIGINAL_START = "2026-11-02T10:00";

describe("rescheduleBooking by the client", () => {
  test("moves a booking outside the window, keeping its length, and emits booking.rescheduled", async () => {
    const { bookingId } = await confirmed(w);
    await rescheduleBooking(w.db, {
      bookingId,
      newStart: local("2026-11-03T13:00"),
      by: "client",
      now: OUTSIDE,
    });

    const row = await bookingRow(w.db, bookingId);
    expect(row.status).toBe("confirmed");
    expect(row.during).toEqual({
      start: local("2026-11-03T13:00"),
      end: local("2026-11-03T13:45"),
    });
    expect(await eventsOfType(w.db, "booking.rescheduled")).toEqual([
      { bookingId, previousStart: local(ORIGINAL_START).toISOString(), notifyClient: true },
    ]);
    expect(await auditActions(w.db, bookingId)).toContain("booking.reschedule");
  });

  test("keeps the buffer in the occupied length", async () => {
    await w.db.update(service).set({ bufferMin: 15 }).where(eq(service.id, w.haircutId));
    const { bookingId } = await confirmed(w);
    await rescheduleBooking(w.db, {
      bookingId,
      newStart: local("2026-11-03T13:00"),
      by: "client",
      now: OUTSIDE,
    });
    expect((await bookingRow(w.db, bookingId)).during.end).toEqual(local("2026-11-03T14:00"));
  });

  test("refuses inside the cancellation window", async () => {
    const { bookingId } = await confirmed(w);
    await expect(
      rescheduleBooking(w.db, {
        bookingId,
        newStart: local("2026-11-03T13:00"),
        by: "client",
        now: INSIDE,
      }),
    ).rejects.toBeInstanceOf(ChangeWindowError);
    expect((await bookingRow(w.db, bookingId)).during.start).toEqual(local(ORIGINAL_START));
    expect(await eventsOfType(w.db, "booking.rescheduled")).toHaveLength(0);
  });

  test("may shift onto a time overlapping the booking's own current slot", async () => {
    const { bookingId } = await confirmed(w);
    await rescheduleBooking(w.db, {
      bookingId,
      newStart: local("2026-11-02T10:15"),
      by: "client",
      now: OUTSIDE,
    });
    expect((await bookingRow(w.db, bookingId)).during.start).toEqual(local("2026-11-02T10:15"));
  });

  test("refuses unavailable targets: occupied, outside hours, off-grid, blocked", async () => {
    const { bookingId } = await confirmed(w);
    await addBooking(w.db, w, local("2026-11-03T13:00"), local("2026-11-03T13:45"));
    await addBlock(w.db, w.staffId, local("2026-11-03T15:00"), local("2026-11-03T16:00"));
    for (const target of [
      "2026-11-03T13:15", // overlaps another booking
      "2026-11-03T07:00", // before opening
      "2026-11-03T12:05", // off the 15 minute grid
      "2026-11-03T15:30", // inside a time block
    ]) {
      await expect(
        rescheduleBooking(w.db, { bookingId, newStart: local(target), by: "client", now: OUTSIDE }),
      ).rejects.toBeInstanceOf(SlotTakenError);
    }
    expect((await bookingRow(w.db, bookingId)).during.start).toEqual(local(ORIGINAL_START));
  });

  test("notifyClient can be switched off", async () => {
    const { bookingId } = await confirmed(w);
    await rescheduleBooking(w.db, {
      bookingId,
      newStart: local("2026-11-03T13:00"),
      by: "client",
      notifyClient: false,
      now: OUTSIDE,
    });
    expect(await eventsOfType(w.db, "booking.rescheduled")).toEqual([
      expect.objectContaining({ notifyClient: false }),
    ]);
  });

  test("a booking with no service lines (manual entry) is checked for conflicts only", async () => {
    const manual = await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    const lines = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, manual.id));
    expect(lines).toHaveLength(0);

    await rescheduleBooking(w.db, {
      bookingId: manual.id,
      newStart: local("2026-11-03T13:00"),
      by: "client",
      now: OUTSIDE,
    });
    expect((await bookingRow(w.db, manual.id)).during.start).toEqual(local("2026-11-03T13:00"));

    await addBooking(w.db, w, local("2026-11-04T13:00"), local("2026-11-04T13:45"));
    await expect(
      rescheduleBooking(w.db, {
        bookingId: manual.id,
        newStart: local("2026-11-04T13:15"),
        by: "client",
        now: OUTSIDE,
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});

describe("rescheduleBooking by staff", () => {
  test("may move inside the window, outside normal hours and inside min notice", async () => {
    const { bookingId } = await confirmed(w);
    await rescheduleBooking(
      w.db,
      { bookingId, newStart: local("2026-11-02T07:30"), by: "staff", now: INSIDE },
      "owner:u1",
    );
    expect((await bookingRow(w.db, bookingId)).during.start).toEqual(local("2026-11-02T07:30"));
    expect(await eventsOfType(w.db, "booking.rescheduled")).toHaveLength(1);
  });

  test("is still blocked by other bookings and time blocks", async () => {
    const { bookingId } = await confirmed(w);
    await addBooking(w.db, w, local("2026-11-02T14:00"), local("2026-11-02T14:45"));
    await addBlock(w.db, w.staffId, local("2026-11-02T16:00"), local("2026-11-02T17:00"));
    for (const target of ["2026-11-02T14:30", "2026-11-02T16:15"]) {
      await expect(
        rescheduleBooking(w.db, { bookingId, newStart: local(target), by: "staff", now: INSIDE }),
      ).rejects.toBeInstanceOf(SlotTakenError);
    }
  });
});

describe("rescheduleBooking: guards", () => {
  test("only confirmed bookings can be moved", async () => {
    const pending = await hold(w);
    await expect(
      rescheduleBooking(w.db, {
        bookingId: pending.bookingId,
        newStart: local("2026-11-03T13:00"),
        by: "staff",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(BookingStateError);

    const { bookingId } = await confirmed(w, { start: local("2026-11-02T14:00") });
    await cancelBooking(w.db, { bookingId, by: "staff", now: NOW });
    await expect(
      rescheduleBooking(w.db, {
        bookingId,
        newStart: local("2026-11-03T13:00"),
        by: "staff",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(BookingStateError);
  });

  test("rejects an invalid new start", async () => {
    const { bookingId } = await confirmed(w);
    await expect(
      rescheduleBooking(w.db, { bookingId, newStart: new Date("garbage"), by: "staff" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
