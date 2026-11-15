import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  auditLog,
  booking,
  bookingService,
  location,
  rosterException,
  service,
  serviceLevelPrice,
  serviceStaff,
  staff,
} from "@/db/schema";
import {
  BookingStateError,
  NotFoundError,
  NotRosteredError,
  SlotTakenError,
  ValidationError,
  cancelBooking,
  reassignBooking,
} from "@/server/booking";
import {
  addBlock,
  addBooking,
  addStaff,
  createWorld,
  local,
  offer,
  openEveryDay,
  setSettings,
  type World,
} from "../availability/setup";
import { createService } from "../helpers/factories";
import { NOW, bookingRow, confirmed, eventsOfType, hold } from "./setup";

let w: World;
let zedId: string;

async function addZed(options: { open?: boolean; offers?: boolean } = {}): Promise<string> {
  const zed = await addStaff(w.db, w.businessId, "Zed");
  if (options.offers !== false) await offer(w.db, w.haircutId, w.locationId, zed.id);
  if (options.open !== false) await openEveryDay(w.db, zed.id, w.locationId);
  return zed.id;
}

beforeEach(async () => {
  w = await createWorld({ minNoticeMin: 0 });
  zedId = await addZed();
});
afterEach(async () => {
  await w.t.client.close();
});

// The booking under test is Monday 2026-11-02 10:00-10:45 with Ryan ("now" is Sunday 08:00).
const reassign = (
  bookingId: string,
  overrides: Partial<Parameters<typeof reassignBooking>[1]> = {},
) => reassignBooking(w.db, { bookingId, newStaffId: zedId, now: NOW, ...overrides });

async function auditFor(bookingId: string) {
  const rows = await w.db.select().from(auditLog).where(eq(auditLog.entityId, bookingId));
  return rows.filter((row) => row.action === "booking.reassign");
}

describe("reassignBooking: the move", () => {
  test("moves a confirmed future booking to the new stylist at the same time", async () => {
    const { bookingId } = await confirmed(w);
    const before = await bookingRow(w.db, bookingId);

    await reassign(bookingId, { actor: "owner:user-1" });

    const after = await bookingRow(w.db, bookingId);
    expect(after.staffId).toBe(zedId);
    expect(after.during).toEqual(before.during);
    expect(after.status).toBe("confirmed");
    expect(after.depositCents).toBe(before.depositCents);
    expect(after.totalCents).toBe(before.totalCents);
  });

  test("emits booking.rescheduled with the previous stylist, and notifyClient true by default / false when asked", async () => {
    const first = await confirmed(w);
    await reassign(first.bookingId);
    const second = await confirmed(w, { start: local("2026-11-02T14:00") });
    await reassign(second.bookingId, { notifyClient: false });

    expect(await eventsOfType(w.db, "booking.rescheduled")).toEqual([
      {
        bookingId: first.bookingId,
        previousStart: local("2026-11-02T10:00").toISOString(),
        notifyClient: true,
        previousStaffId: w.staffId,
      },
      {
        bookingId: second.bookingId,
        previousStart: local("2026-11-02T14:00").toISOString(),
        notifyClient: false,
        previousStaffId: w.staffId,
      },
    ]);
  });

  test("writes an audit row with the actor from the input", async () => {
    const { bookingId } = await confirmed(w);
    await reassign(bookingId, { actor: "staff:user-9" });
    const [row] = await auditFor(bookingId);
    expect(row.actor).toBe("staff:user-9");
    expect(row.data).toMatchObject({ fromStaffId: w.staffId, toStaffId: zedId });
  });

  test("defaults the audit actor to system", async () => {
    const { bookingId } = await confirmed(w);
    await reassign(bookingId);
    expect((await auditFor(bookingId))[0].actor).toBe("system");
  });

  test("rejects an actor that is not owner:<id> or staff:<id>", async () => {
    const { bookingId } = await confirmed(w);
    await expect(reassign(bookingId, { actor: "someone" })).rejects.toBeInstanceOf(ValidationError);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(w.staffId);
  });

  test("leaves staffRequested as it was", async () => {
    const { bookingId } = await confirmed(w, { staffRequested: true });
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).staffRequested).toBe(true);
  });

  test("the old stylist's time is free afterwards", async () => {
    const { bookingId } = await confirmed(w);
    await reassign(bookingId);
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
  });

  test("defaults the clock to now", async () => {
    await setSettings(w.db, w.businessId, { minNoticeMin: 0, maxAdvanceDays: 5000 });
    const { bookingId } = await confirmed(w, { start: local("2030-01-07T10:00"), now: NOW });
    await expect(reassignBooking(w.db, { bookingId, newStaffId: zedId })).resolves.toBeUndefined();
  });
});

describe("reassignBooking: prices follow the new stylist's level", () => {
  test("a different price stores the new total, keeps the deposit and reports the difference", async () => {
    await w.db.update(staff).set({ level: 2 }).where(eq(staff.id, zedId));
    await w.db
      .insert(serviceLevelPrice)
      .values({ serviceId: w.haircutId, level: 2, priceCents: 12000 });
    const { bookingId, depositCents } = await confirmed(w);

    await reassign(bookingId, { actor: "owner:user-1" });

    const row = await bookingRow(w.db, bookingId);
    expect(row.totalCents).toBe(12000);
    expect(row.depositCents).toBe(depositCents);
    const lines = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, bookingId));
    expect(lines.map((l) => l.priceCents)).toEqual([12000]);
    const [audit] = await auditFor(bookingId);
    expect(audit.data).toMatchObject({
      previousTotalCents: 9500,
      totalCents: 12000,
      totalDifferenceCents: 2500,
      depositCents,
      newStylistLevel: 2,
    });
  });

  test("the new stylist's own override applies too (a lower price gives a negative difference)", async () => {
    await w.db
      .update(serviceStaff)
      .set({ priceCents: 8000 })
      .where(eq(serviceStaff.staffId, zedId));
    const { bookingId } = await confirmed(w);
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).totalCents).toBe(8000);
    expect((await auditFor(bookingId))[0].data).toMatchObject({ totalDifferenceCents: -1500 });
  });

  test("equal prices leave the total alone and report no difference", async () => {
    const { bookingId } = await confirmed(w);
    await reassign(bookingId);
    expect((await auditFor(bookingId))[0].data).toMatchObject({ totalDifferenceCents: 0 });
  });
});

describe("reassignBooking: booking state", () => {
  test("refuses a pending booking", async () => {
    const { bookingId } = await hold(w);
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(BookingStateError);
  });

  test("refuses a cancelled booking", async () => {
    const { bookingId } = await confirmed(w);
    await cancelBooking(w.db, { bookingId, by: "staff", now: NOW });
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(BookingStateError);
  });

  test("refuses a booking that has started", async () => {
    const { bookingId } = await confirmed(w);
    await expect(reassign(bookingId, { now: local("2026-11-02T10:00") })).rejects.toBeInstanceOf(
      BookingStateError,
    );
    await expect(reassign(bookingId, { now: local("2026-11-02T12:00") })).rejects.toBeInstanceOf(
      BookingStateError,
    );
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(w.staffId);
  });

  test("refuses the stylist who already has it", async () => {
    const { bookingId } = await confirmed(w);
    await expect(reassign(bookingId, { newStaffId: w.staffId })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test("unknown booking and unknown or malformed staff ids are not found", async () => {
    const { bookingId } = await confirmed(w);
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(reassign(missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(reassign(bookingId, { newStaffId: missing })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(reassign(bookingId, { newStaffId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("refuses an inactive stylist", async () => {
    const { bookingId } = await confirmed(w);
    await w.db.update(staff).set({ active: false }).where(eq(staff.id, zedId));
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("reassignBooking: services", () => {
  test("refuses a stylist who does not offer the service", async () => {
    const other = await addZed({ offers: false });
    const { bookingId } = await confirmed(w);
    await expect(reassign(bookingId, { newStaffId: other })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(w.staffId);
  });

  test("the stylist must offer EVERY service in a multi-service booking", async () => {
    const colour = await createService(w.db, w.businessId, { name: "Colour", durationMin: 60 });
    await offer(w.db, colour.id, w.locationId, w.staffId);
    const { bookingId } = await confirmed(w, { serviceIds: [w.haircutId, colour.id] });
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(ValidationError); // Zed lacks Colour
    await offer(w.db, colour.id, w.locationId, zedId);
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(zedId);
  });

  test("a service that is no longer active blocks the move", async () => {
    const { bookingId } = await confirmed(w);
    await w.db.update(service).set({ active: false }).where(eq(service.id, w.haircutId));
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(ValidationError);
  });

  test("a booking with no catalogue service lines cannot be checked", async () => {
    const manual = await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    await expect(reassign(manual.id)).rejects.toBeInstanceOf(ValidationError);
  });

  test("a line whose service was removed from the catalogue cannot be checked", async () => {
    const { bookingId } = await confirmed(w);
    await w.db
      .update(bookingService)
      .set({ serviceId: null })
      .where(eq(bookingService.bookingId, bookingId));
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("reassignBooking: roster", () => {
  test("refuses a stylist with no hours that day", async () => {
    const idle = await addZed({ open: false });
    const { bookingId } = await confirmed(w);
    await expect(reassign(bookingId, { newStaffId: idle })).rejects.toBeInstanceOf(
      NotRosteredError,
    );
  });

  test("refuses a stylist on a day off", async () => {
    await w.db
      .insert(rosterException)
      .values({ staffId: zedId, date: "2026-11-02", kind: "off", locationId: null });
    const { bookingId } = await confirmed(w);
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(NotRosteredError);
  });

  test("honours custom hours: the whole appointment must fit", async () => {
    await w.db.insert(rosterException).values({
      staffId: zedId,
      date: "2026-11-02",
      kind: "custom",
      locationId: w.locationId,
      startMinute: 600,
      endMinute: 645, // 10:00-10:45
    });
    const fits = await confirmed(w);
    await reassign(fits.bookingId);
    expect((await bookingRow(w.db, fits.bookingId)).staffId).toBe(zedId);

    const spills = await confirmed(w, { start: local("2026-11-02T10:15") });
    await expect(reassign(spills.bookingId)).rejects.toBeInstanceOf(NotRosteredError);
  });

  test("a day off at a different location does not matter", async () => {
    const [elsewhere] = await w.db
      .insert(location)
      .values({ businessId: w.businessId, name: "Elsewhere" })
      .returning();
    await w.db
      .insert(rosterException)
      .values({ staffId: zedId, date: "2026-11-02", kind: "off", locationId: elsewhere.id });
    const { bookingId } = await confirmed(w);
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(zedId);
  });

  test("the service buffer may run past the end of the working day", async () => {
    await w.db.update(service).set({ bufferMin: 30 }).where(eq(service.id, w.haircutId));
    // Zed works until 17:00; the appointment ends exactly then, the buffer runs to 17:30.
    const { bookingId } = await confirmed(w, { start: local("2026-11-02T16:15") });
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(zedId);
  });

  test("an appointment that ends after the working day is refused", async () => {
    // Staff may enter a booking that runs past 17:00 (it could not be booked online).
    const late = await addBooking(w.db, w, local("2026-11-02T16:30"), local("2026-11-02T17:15"));
    await w.db.insert(bookingService).values({
      bookingId: late.id,
      serviceId: w.haircutId,
      name: "Haircut",
      durationMin: 45,
      priceCents: 9500,
    });
    await expect(reassign(late.id)).rejects.toBeInstanceOf(NotRosteredError);
  });
});

describe("reassignBooking: the new stylist must be free", () => {
  test("refuses when the new stylist has an overlapping booking", async () => {
    const { bookingId } = await confirmed(w);
    await addBooking(
      w.db,
      { ...w, staffId: zedId },
      local("2026-11-02T10:30"),
      local("2026-11-02T11:15"),
    );
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(SlotTakenError);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(w.staffId);
    expect(await eventsOfType(w.db, "booking.rescheduled")).toHaveLength(0);
    expect(await auditFor(bookingId)).toHaveLength(0);
  });

  test("refuses when the new stylist has blocked time", async () => {
    const { bookingId } = await confirmed(w);
    await addBlock(w.db, zedId, local("2026-11-02T09:00"), local("2026-11-02T10:15"));
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(SlotTakenError);
  });

  test("a back-to-back booking is fine", async () => {
    const { bookingId } = await confirmed(w);
    await addBooking(
      w.db,
      { ...w, staffId: zedId },
      local("2026-11-02T10:45"),
      local("2026-11-02T11:30"),
    );
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(zedId);
  });

  test("a live pending hold on the new stylist blocks, a lapsed one does not", async () => {
    const { bookingId } = await confirmed(w);
    const zedBooking = { ...w, staffId: zedId };
    const held = await addBooking(
      w.db,
      zedBooking,
      local("2026-11-02T10:00"),
      local("2026-11-02T10:45"),
      { status: "pending_payment", holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000) },
    );
    await expect(reassign(bookingId)).rejects.toBeInstanceOf(SlotTakenError);

    await w.db
      .update(booking)
      .set({ holdExpiresAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(booking.id, held.id));
    await reassign(bookingId);
    expect((await bookingRow(w.db, bookingId)).staffId).toBe(zedId);
    expect((await bookingRow(w.db, held.id)).status).toBe("expired");
  });
});
