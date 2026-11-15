import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { booking, waitlistOffer } from "@/db/schema";
import { cancelBooking, confirmBooking, expireHolds, rescheduleBooking } from "@/server/booking";
import {
  claimOffer,
  expireWaitlist,
  handleWaitlistEvent,
  type WaitlistEventContext,
} from "@/server/waitlist";
import { createWorld, local, setSettings, type World } from "../availability/setup";
import {
  MONDAY_10,
  NOW,
  bookedSlot,
  entryRow,
  join,
  offerRow,
  offerTo,
  opts,
  person,
  tokenFor,
} from "./setup";

let w: World;
const log = vi.fn();
let now = NOW;
const ctx = (): WaitlistEventContext => ({ db: w.db, log, now: () => now });
const send = (data: Record<string, unknown>) => handleWaitlistEvent(ctx(), data);

beforeEach(async () => {
  w = await createWorld();
  now = NOW;
  log.mockClear();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("freed slots", () => {
  test("booking.cancelled offers the cancelled time to a matching entry", async () => {
    const { entryId } = await join(w, { client: person(2) });
    const booked = await bookedSlot(w);
    await cancelBooking(w.db, { bookingId: booked.bookingId, by: "client", now: NOW });
    await send({ type: "booking.cancelled", bookingId: booked.bookingId });
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
    const offers = await w.db.select().from(waitlistOffer);
    expect(offers).toHaveLength(1);
    expect(offers[0].during.start).toEqual(local(MONDAY_10));
  });

  test("replaying the event does not offer twice", async () => {
    await join(w, { client: person(2) });
    const booked = await bookedSlot(w);
    await cancelBooking(w.db, { bookingId: booked.bookingId, by: "client", now: NOW });
    await send({ type: "booking.cancelled", bookingId: booked.bookingId });
    await send({ type: "booking.cancelled", bookingId: booked.bookingId });
    expect(await w.db.select().from(waitlistOffer)).toHaveLength(1);
  });

  test("booking.expired offers the lapsed hold's time", async () => {
    const { entryId } = await join(w, { client: person(2) });
    const { createHold } = await import("@/server/booking");
    const hold = await createHold(
      w.db,
      {
        locationId: w.locationId,
        staffId: w.staffId,
        serviceIds: [w.haircutId],
        start: local(MONDAY_10),
        client: { firstName: "A", lastName: "B", email: "a@b.com", phone: "0412345678" },
        policyVersion: "1",
        now: NOW,
      },
      opts,
    );
    await expireHolds(w.db, new Date(NOW.getTime() + 11 * 60_000));
    now = new Date(NOW.getTime() + 11 * 60_000);
    await send({ type: "booking.expired", bookingId: hold.bookingId });
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
  });

  test("booking.rescheduled offers the old time, with the booking's own length", async () => {
    const { entryId } = await join(w, { client: person(2) });
    const booked = await bookedSlot(w);
    await rescheduleBooking(w.db, {
      bookingId: booked.bookingId,
      newStart: local("2026-11-03T14:00"),
      by: "staff",
      now: NOW,
    });
    await send({
      type: "booking.rescheduled",
      bookingId: booked.bookingId,
      previousStart: local(MONDAY_10).toISOString(),
      notifyClient: true,
    });
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
    const [offer] = await w.db.select().from(waitlistOffer);
    expect(offer.during.start).toEqual(local(MONDAY_10));
  });

  test("a rescheduled event with an unchanged start frees nothing", async () => {
    await join(w, { client: person(2) });
    const booked = await bookedSlot(w);
    await send({
      type: "booking.rescheduled",
      bookingId: booked.bookingId,
      previousStart: local(MONDAY_10).toISOString(),
      notifyClient: false,
    });
    expect(await w.db.select().from(waitlistOffer)).toHaveLength(0);
  });

  test("ignores other events, unknown bookings and bad dates", async () => {
    await send({ type: "payment.succeeded", paymentId: "x" });
    await send({ type: "booking.cancelled", bookingId: "6f1c8d3e-1111-4222-8333-444455556666" });
    await send({
      type: "booking.rescheduled",
      bookingId: "6f1c8d3e-1111-4222-8333-444455556666",
      previousStart: "nonsense",
      notifyClient: true,
    });
    const booked = await bookedSlot(w);
    await send({
      type: "booking.rescheduled",
      bookingId: booked.bookingId,
      previousStart: "nonsense",
      notifyClient: true,
    });
    expect(await w.db.select().from(waitlistOffer)).toHaveLength(0);
  });

  test("a malformed payload for a known event throws so the job is retried", async () => {
    await expect(send({ type: "booking.cancelled", bookingId: "nope" })).rejects.toThrow();
  });
});

describe("booking.confirmed", () => {
  async function claimedAndPaid(n = 1) {
    const { entryId } = await join(w, { client: person(n) });
    const { offerId } = await offerTo(w, entryId);
    const hold = await claimOffer(w.db, tokenFor(offerId), NOW, { ...opts, policyVersion: "1" });
    return { entryId, offerId, hold };
  }

  test("books the claiming entry and records the booking", async () => {
    const { entryId, hold } = await claimedAndPaid();
    await confirmBooking(w.db, hold.bookingId, NOW);
    await send({ type: "booking.confirmed", bookingId: hold.bookingId });
    expect(await entryRow(w.db, entryId)).toMatchObject({
      status: "booked",
      bookedBookingId: hold.bookingId,
    });
  });

  test("closes competing offers for the same slot and sends those people back to waiting", async () => {
    await setSettings(w.db, w.businessId, { waitlistMaxOffersPerSlot: 3 });
    const winnerEntry = await join(w, { client: person(1) });
    const winnerOffer = await offerTo(w, winnerEntry.entryId);
    const loserEntry = await join(w, { client: person(2) });
    const loserOffer = await offerTo(w, loserEntry.entryId);
    const winner = {
      hold: await claimOffer(w.db, tokenFor(winnerOffer.offerId), NOW, {
        ...opts,
        policyVersion: "1",
      }),
    };
    await confirmBooking(w.db, winner.hold.bookingId, NOW);
    await send({ type: "booking.confirmed", bookingId: winner.hold.bookingId });

    expect((await offerRow(w.db, loserOffer.offerId)).status).toBe("slot_taken");
    expect((await entryRow(w.db, loserEntry.entryId)).status).toBe("waiting");
  });

  test("replaying the event changes nothing more", async () => {
    const { entryId, hold } = await claimedAndPaid();
    await confirmBooking(w.db, hold.bookingId, NOW);
    await send({ type: "booking.confirmed", bookingId: hold.bookingId });
    await send({ type: "booking.confirmed", bookingId: hold.bookingId });
    expect((await entryRow(w.db, entryId)).status).toBe("booked");
  });

  test("archives the client's other entries that a normal booking satisfies", async () => {
    const mine = await join(w, { client: person(3), weekdays: [1] });
    const wrongDay = await join(w, { client: person(3), weekdays: [3], latestDate: "2026-11-07" });
    const { createHold } = await import("@/server/booking");
    const hold = await createHold(
      w.db,
      {
        locationId: w.locationId,
        staffId: w.staffId,
        serviceIds: [w.haircutId],
        start: local(MONDAY_10),
        client: person(3),
        policyVersion: "1",
        now: NOW,
      },
      opts,
    );
    await confirmBooking(w.db, hold.bookingId, NOW);
    await send({ type: "booking.confirmed", bookingId: hold.bookingId });
    expect((await entryRow(w.db, mine.entryId)).status).toBe("booked");
    expect((await entryRow(w.db, wrongDay.entryId)).status).toBe("waiting");
  });

  test("a booking that was cancelled before the event is ignored", async () => {
    const { entryId, hold } = await claimedAndPaid();
    await confirmBooking(w.db, hold.bookingId, NOW);
    await w.db.update(booking).set({ status: "cancelled_by_client" }).where(eq(booking.id, hold.bookingId));
    await send({ type: "booking.confirmed", bookingId: hold.bookingId });
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
  });
});

describe("expireWaitlist", () => {
  test("expires offers past their window and sends the entry back to waiting", async () => {
    const { entryId } = await join(w);
    const { offerId } = await offerTo(w, entryId);
    const later = new Date(NOW.getTime() + 25 * 60_000);
    expect(await expireWaitlist(w.db, later)).toBe(2);
    expect((await offerRow(w.db, offerId)).status).toBe("expired");
    expect((await entryRow(w.db, entryId)).status).toBe("waiting");
    expect(await expireWaitlist(w.db, later)).toBe(0);
  });

  test("keeps an entry offered while an offer is live", async () => {
    const { entryId } = await join(w);
    await offerTo(w, entryId);
    expect(await expireWaitlist(w.db, new Date(NOW.getTime() + 5 * 60_000))).toBe(0);
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
  });

  test("expires entries past their last date, along with open offers", async () => {
    const { entryId } = await join(w);
    const { offerId } = await offerTo(w, entryId);
    const after = local("2026-11-07T00:00");
    expect(await expireWaitlist(w.db, after)).toBe(2);
    expect((await entryRow(w.db, entryId)).status).toBe("expired");
    expect((await offerRow(w.db, offerId)).status).toBe("expired");
  });

  test("an entry whose offer was taken goes back to waiting while it has time, not once its window is over", async () => {
    const { entryId } = await join(w);
    const { offerId } = await offerTo(w, entryId);
    await w.db.update(waitlistOffer).set({ status: "slot_taken" }).where(eq(waitlistOffer.id, offerId));
    expect(await expireWaitlist(w.db, NOW)).toBe(1);
    expect((await entryRow(w.db, entryId)).status).toBe("waiting");
  });

  test("an entry with a claimed, unpaid booking stays offered; it reverts when that hold lapses", async () => {
    const { entryId } = await join(w);
    const { offerId } = await offerTo(w, entryId);
    await claimOffer(w.db, tokenFor(offerId), NOW, { ...opts, policyVersion: "1" });
    expect(await expireWaitlist(w.db, new Date(NOW.getTime() + 5 * 60_000))).toBe(0);
    const lapsed = new Date(NOW.getTime() + 15 * 60_000);
    await expireHolds(w.db, lapsed);
    expect(await expireWaitlist(w.db, lapsed)).toBeGreaterThan(0);
    expect((await entryRow(w.db, entryId)).status).toBe("waiting");
  });
});
