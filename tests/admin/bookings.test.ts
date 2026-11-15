import type { AccessContext } from "@/server/admin/access";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { createService, seedBasics } from "../helpers/factories";
import {
  auditLog,
  booking,
  bookingService,
  business,
  client,
  messageLog,
  payment,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { getBookingDetail, getCheckoutView, listBookings } from "@/server/admin/bookings";

const OWNER: AccessContext = { role: "owner", staffId: null };

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;

const NOW = new Date("2026-11-14T00:00:00Z");
const range = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

async function addBooking(
  status: typeof booking.$inferInsert.status,
  start: string,
  end: string,
  overrides: Partial<typeof booking.$inferInsert> = {},
) {
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId: seed.stylist.id,
      locationId: seed.loc.id,
      clientId: seed.cl.id,
      status,
      during: range(start, end),
      totalCents: 20000,
      depositCents: 10000,
      ...overrides,
    })
    .returning();
  return row;
}

async function addPayment(
  bookingId: string,
  kind: typeof payment.$inferInsert.kind,
  amountCents: number,
  overrides: Partial<typeof payment.$inferInsert> = {},
) {
  await t.db.insert(payment).values({
    bookingId,
    kind,
    method: "stripe_online",
    status: "succeeded",
    amountCents,
    ...overrides,
  });
}

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterEach(async () => {
  await t.client.close();
});

describe("getBookingDetail", () => {
  test("returns null for an unknown booking", async () => {
    expect(await getBookingDetail(t.db, crypto.randomUUID(), OWNER, NOW)).toBeNull();
  });

  test("assembles client, services, payments, messages and audit trail", async () => {
    const svc = await createService(t.db, seed.biz.id, { name: "Cut" });
    const b = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z", {
      comments: "Lighter on top",
    });
    await t.db.insert(bookingService).values({
      bookingId: b.id,
      serviceId: svc.id,
      name: "Cut",
      durationMin: 45,
      priceCents: 20000,
    });
    await addPayment(b.id, "deposit", 10000);
    await t.db.insert(messageLog).values({
      bookingId: b.id,
      clientId: seed.cl.id,
      channel: "sms",
      template: "confirmation",
      toAddress: "+61400000000",
      status: "sent",
    });
    await t.db.insert(auditLog).values({
      actor: "owner:u1",
      action: "booking.rescheduled",
      entityType: "booking",
      entityId: b.id,
    });

    const detail = await getBookingDetail(t.db, b.id, OWNER, NOW);

    expect(detail).toMatchObject({
      id: b.id,
      status: "confirmed",
      comments: "Lighter on top",
      location: { name: "Northside" },
      staff: { name: "Ryan" },
      client: { name: "Sam Client", email: "sam@example.com" },
      totalCents: 20000,
      depositCents: 10000,
      paidCents: 10000,
      balanceDueCents: 10000,
    });
    expect(detail?.services).toEqual([
      { id: expect.any(String), name: "Cut", durationMin: 45, priceCents: 20000 },
    ]);
    expect(detail?.payments).toHaveLength(1);
    expect(detail?.messages[0]).toMatchObject({ template: "confirmation", status: "sent" });
    expect(detail?.audit[0]).toMatchObject({ action: "booking.rescheduled", actor: "owner:u1" });
  });

  test("net paid subtracts refunds and ignores unsettled payments", async () => {
    const b = await addBooking(
      "cancelled_by_staff",
      "2026-11-16T03:00:00Z",
      "2026-11-16T04:00:00Z",
    );
    await addPayment(b.id, "deposit", 10000, { status: "refunded" });
    await addPayment(b.id, "refund", 10000);
    await addPayment(b.id, "balance", 5000, { status: "pending" });

    const detail = await getBookingDetail(t.db, b.id, OWNER, NOW);
    expect(detail?.paidCents).toBe(0);
  });

  test("partial refunds reduce the net paid amount", async () => {
    const b = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    await addPayment(b.id, "deposit", 10000, { status: "partially_refunded" });
    await addPayment(b.id, "refund", 2500);
    const detail = await getBookingDetail(t.db, b.id, OWNER, NOW);
    expect(detail?.paidCents).toBe(7500);
    expect(detail?.balanceDueCents).toBe(12500);
  });

  test("completed bookings owe nothing, even after a cash discount", async () => {
    const b = await addBooking("completed", "2026-11-10T03:00:00Z", "2026-11-10T04:00:00Z");
    await addPayment(b.id, "deposit", 10000);
    await addPayment(b.id, "balance", 9000, { method: "cash" });
    const detail = await getBookingDetail(t.db, b.id, OWNER, NOW);
    expect(detail?.paidCents).toBe(19000);
    expect(detail?.balanceDueCents).toBe(0);
  });

  test("allowed actions follow status and time", async () => {
    const future = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    const past = await addBooking("confirmed", "2026-11-10T03:00:00Z", "2026-11-10T04:00:00Z");
    const done = await addBooking("completed", "2026-11-11T03:00:00Z", "2026-11-11T04:00:00Z");
    const pending = await addBooking(
      "pending_payment",
      "2026-11-17T03:00:00Z",
      "2026-11-17T04:00:00Z",
    );

    expect((await getBookingDetail(t.db, future.id, OWNER, NOW))?.allowed).toEqual({
      move: true,
      cancel: true,
      noShow: false,
      checkout: true,
      resend: true,
      reassign: true,
      refund: true,
    });
    expect((await getBookingDetail(t.db, past.id, OWNER, NOW))?.allowed.noShow).toBe(true);
    expect((await getBookingDetail(t.db, done.id, OWNER, NOW))?.allowed).toEqual({
      move: false,
      cancel: false,
      noShow: false,
      checkout: false,
      resend: false,
      reassign: false,
      refund: true,
    });
    expect((await getBookingDetail(t.db, pending.id, OWNER, NOW))?.allowed).toEqual({
      move: true,
      cancel: true,
      noShow: false,
      checkout: false,
      resend: false,
      reassign: false,
      refund: true,
    });
  });
});

describe("listBookings", () => {
  test("splits upcoming, past and cancelled", async () => {
    const soon = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    const sooner = await addBooking(
      "pending_payment",
      "2026-11-15T03:00:00Z",
      "2026-11-15T04:00:00Z",
    );
    const old = await addBooking("completed", "2026-11-10T03:00:00Z", "2026-11-10T04:00:00Z");
    const awaiting = await addBooking("confirmed", "2026-11-12T03:00:00Z", "2026-11-12T04:00:00Z");
    const ns = await addBooking("no_show", "2026-11-11T03:00:00Z", "2026-11-11T04:00:00Z");
    const cancelled = await addBooking(
      "cancelled_by_client",
      "2026-11-17T03:00:00Z",
      "2026-11-17T04:00:00Z",
    );
    const late = await addBooking("late_cancelled", "2026-11-18T03:00:00Z", "2026-11-18T04:00:00Z");
    await addBooking("expired", "2026-11-19T03:00:00Z", "2026-11-19T04:00:00Z");

    const ids = async (filter: "upcoming" | "past" | "cancelled") =>
      (await listBookings(t.db, OWNER, { filter, now: NOW })).map((r) => r.id);

    expect(await ids("upcoming")).toEqual([sooner.id, soon.id]);
    expect(await ids("past")).toEqual([awaiting.id, ns.id, old.id]);
    expect(await ids("cancelled")).toEqual([late.id, cancelled.id]);
  });

  test("searches by client name, email or phone digits", async () => {
    const other = await t.db
      .insert(client)
      .values({
        businessId: seed.biz.id,
        firstName: "Jo",
        lastName: "Smith",
        email: "jo@example.com",
        phone: "+61411222333",
      })
      .returning();
    const a = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    const b = await addBooking("confirmed", "2026-11-17T03:00:00Z", "2026-11-17T04:00:00Z", {
      clientId: other[0].id,
    });

    const search = async (q: string) =>
      (await listBookings(t.db, OWNER, { filter: "upcoming", q, now: NOW })).map((r) => r.id);
    expect(await search("sam")).toEqual([a.id]);
    expect(await search("Jo Smith")).toEqual([b.id]);
    expect(await search("jo@example")).toEqual([b.id]);
    expect(await search("0411 222 333")).toEqual([b.id]);
    expect(await search("%")).toEqual([]);
  });

  test("row carries client, location and service summary", async () => {
    const b = await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    await t.db.insert(bookingService).values({
      bookingId: b.id,
      name: "Cut",
      durationMin: 45,
      priceCents: 100,
    });
    const [row] = await listBookings(t.db, OWNER, { filter: "upcoming", now: NOW });
    expect(row).toMatchObject({
      id: b.id,
      clientName: "Sam Client",
      locationName: "Northside",
      services: ["Cut"],
      totalCents: 20000,
    });
  });

  test("respects the limit", async () => {
    await addBooking("confirmed", "2026-11-16T03:00:00Z", "2026-11-16T04:00:00Z");
    await addBooking("confirmed", "2026-11-17T03:00:00Z", "2026-11-17T04:00:00Z");
    const rows = await listBookings(t.db, OWNER, { filter: "upcoming", now: NOW, limit: 1 });
    expect(rows).toHaveLength(1);
  });
});

describe("getCheckoutView", () => {
  test("returns null for an unknown booking", async () => {
    expect(await getCheckoutView(t.db, crypto.randomUUID(), OWNER)).toBeNull();
  });

  test("exposes totals, cash discount setting and services", async () => {
    await t.db
      .update(business)
      .set({ settings: { cashDiscountPct: 5 } })
      .where(eq(business.id, seed.biz.id));
    const b = await addBooking("confirmed", "2026-11-13T03:00:00Z", "2026-11-13T04:00:00Z");
    await t.db.insert(bookingService).values({
      bookingId: b.id,
      name: "Cut",
      durationMin: 45,
      priceCents: 20000,
    });
    await addPayment(b.id, "deposit", 10000);

    const view = await getCheckoutView(t.db, b.id, OWNER);
    expect(view).toMatchObject({
      bookingId: b.id,
      status: "confirmed",
      clientName: "Sam Client",
      locationName: "Northside",
      totalCents: 20000,
      paidCents: 10000,
      cashDiscountPct: 5,
      balanceAlreadyRecorded: false,
      receipt: null,
    });
    expect(view?.services).toEqual([{ name: "Cut", priceCents: 20000 }]);
  });

  test("flags an already recorded balance and gives a receipt once completed", async () => {
    const b = await addBooking("completed", "2026-11-13T03:00:00Z", "2026-11-13T04:00:00Z");
    await addPayment(b.id, "deposit", 10000);
    await addPayment(b.id, "balance", 9500, { method: "cash" });

    const view = await getCheckoutView(t.db, b.id, OWNER);
    expect(view?.balanceAlreadyRecorded).toBe(true);
    expect(view?.receipt?.paidCents).toBe(19500);
    expect(view?.receipt?.payments.map((p) => p.kind).sort()).toEqual(["balance", "deposit"]);
  });
});
