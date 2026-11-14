import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { createService, seedBasics } from "../helpers/factories";
import { auditLog, booking, business, client, payment } from "@/db/schema";
import type { AdminDomain } from "@/server/admin/domain";
import {
  cancelStaffBooking,
  checkoutBooking,
  createStaffBooking,
  markBookingNoShow,
  mergeClientRecords,
  refundBookingPayment,
  resendBookingConfirmation,
  rescheduleStaffBooking,
  type CommandContext,
} from "@/server/admin/commands";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let domain: { [K in keyof AdminDomain]: ReturnType<typeof vi.fn> };
let ctx: CommandContext;

const NOW = new Date("2026-11-14T00:00:00Z");

function makeDomain() {
  return {
    createHold: vi.fn(async () => ({
      bookingId: "11111111-1111-4111-8111-111111111111",
      manageToken: "tok",
      holdExpiresAt: new Date(),
      totalCents: 100,
      depositCents: 50,
      during: { start: NOW, end: NOW },
    })),
    confirmBooking: vi.fn(async () => undefined),
    cancelBooking: vi.fn(async () => ({
      bookingId: "x",
      status: "cancelled_by_staff" as const,
      depositAction: "refund" as const,
      feeCents: 0,
    })),
    rescheduleBooking: vi.fn(async () => undefined),
    markNoShow: vi.fn(async () => ({
      bookingId: "x",
      status: "no_show" as never,
      depositAction: "keep" as const,
      feeCents: 0,
    })),
    completeBooking: vi.fn(async () => undefined),
    recordManualPayment: vi.fn(async () => undefined),
    refundPayment: vi.fn(async () => undefined),
    resendConfirmation: vi.fn(async () => undefined),
    mergeClients: vi.fn(async () => undefined),
  };
}

async function addBooking(
  status: typeof booking.$inferInsert.status = "confirmed",
  overrides: Partial<typeof booking.$inferInsert> = {},
) {
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId: seed.stylist.id,
      locationId: seed.loc.id,
      clientId: seed.cl.id,
      status,
      during: { start: new Date("2026-11-13T03:00:00Z"), end: new Date("2026-11-13T04:00:00Z") },
      totalCents: 20000,
      depositCents: 10000,
      ...overrides,
    })
    .returning();
  return row;
}

async function audits() {
  return t.db.select().from(auditLog);
}

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
  await t.db
    .update(business)
    .set({ settings: { policyVersion: "7", cashDiscountPct: 10 } })
    .where(eq(business.id, seed.biz.id));
  domain = makeDomain();
  ctx = { db: t.db, actor: "owner:u1", domain: domain as unknown as AdminDomain, now: NOW };
});
afterEach(async () => {
  await t.client.close();
});

describe("createStaffBooking", () => {
  const start = new Date("2026-11-16T03:00:00Z");

  test("holds then confirms with source admin and the current policy version, no deposit needed", async () => {
    const svc = await createService(t.db, seed.biz.id);
    const result = await createStaffBooking(ctx, {
      locationId: seed.loc.id,
      staffId: seed.stylist.id,
      serviceIds: [svc.id],
      start,
      client: { existingClientId: seed.cl.id },
      comments: "Walk-in rebook",
      notifyClient: false,
    });

    expect(result.bookingId).toBe("11111111-1111-4111-8111-111111111111");
    expect(domain.createHold).toHaveBeenCalledOnce();
    const input = domain.createHold.mock.calls[0][1];
    expect(input).toMatchObject({
      locationId: seed.loc.id,
      staffId: seed.stylist.id,
      serviceIds: [svc.id],
      start,
      source: "admin",
      policyVersion: "7",
      comments: "Walk-in rebook",
      client: { firstName: "Sam", lastName: "Client", email: "sam@example.com" },
    });
    expect(domain.confirmBooking).toHaveBeenCalledWith(t.db, result.bookingId);
    const [audit] = await audits();
    expect(audit).toMatchObject({
      actor: "owner:u1",
      action: "booking.created_by_staff",
      entityType: "booking",
      entityId: result.bookingId,
    });
    expect(audit.data).toMatchObject({ notifyClient: false });
  });

  test("passes a brand new client through for find-or-create", async () => {
    await createStaffBooking(ctx, {
      locationId: seed.loc.id,
      serviceIds: ["22222222-2222-4222-8222-222222222222"],
      start,
      client: {
        newClient: { firstName: "Jo", lastName: "Smith", phone: "+61411222333", email: "" },
      },
      notifyClient: true,
    });
    expect(domain.createHold.mock.calls[0][1].client).toMatchObject({
      firstName: "Jo",
      lastName: "Smith",
      phone: "+61411222333",
    });
  });

  test("fails clearly for an unknown existing client", async () => {
    await expect(
      createStaffBooking(ctx, {
        locationId: seed.loc.id,
        serviceIds: ["22222222-2222-4222-8222-222222222222"],
        start,
        client: { existingClientId: crypto.randomUUID() },
        notifyClient: true,
      }),
    ).rejects.toThrow(/client was not found/i);
    expect(domain.createHold).not.toHaveBeenCalled();
  });

  test("releases the held slot when confirmation fails", async () => {
    domain.confirmBooking.mockRejectedValueOnce(new Error("boom"));
    await expect(
      createStaffBooking(ctx, {
        locationId: seed.loc.id,
        serviceIds: ["22222222-2222-4222-8222-222222222222"],
        start,
        client: { existingClientId: seed.cl.id },
        notifyClient: true,
      }),
    ).rejects.toThrow("boom");
    expect(domain.cancelBooking).toHaveBeenCalledWith(
      t.db,
      expect.objectContaining({ bookingId: "11111111-1111-4111-8111-111111111111", by: "staff" }),
    );
    expect(await audits()).toHaveLength(0);
  });

  test("a failing cleanup does not hide the original error", async () => {
    domain.confirmBooking.mockRejectedValueOnce(new Error("boom"));
    domain.cancelBooking.mockRejectedValueOnce(new Error("cleanup failed"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      createStaffBooking(ctx, {
        locationId: seed.loc.id,
        serviceIds: ["22222222-2222-4222-8222-222222222222"],
        start,
        client: { existingClientId: seed.cl.id },
        notifyClient: true,
      }),
    ).rejects.toThrow("boom");
    expect(String(write.mock.calls[0][0])).toContain("failed to release hold");
    write.mockRestore();
  });
});

describe("rescheduleStaffBooking", () => {
  test("reschedules as staff with the notify choice and audits it", async () => {
    const b = await addBooking();
    const newStart = new Date("2026-11-20T05:00:00Z");
    await rescheduleStaffBooking(ctx, { bookingId: b.id, newStart, notifyClient: true });

    expect(domain.rescheduleBooking).toHaveBeenCalledWith(t.db, {
      bookingId: b.id,
      newStart,
      by: "staff",
      notifyClient: true,
    });
    const [audit] = await audits();
    expect(audit).toMatchObject({ action: "booking.rescheduled_by_staff", entityId: b.id });
    expect(audit.data).toMatchObject({ newStart: newStart.toISOString(), notifyClient: true });
  });
});

describe("cancelStaffBooking", () => {
  test("refund mode forces a refund and returns the outcome", async () => {
    const b = await addBooking();
    const outcome = await cancelStaffBooking(ctx, {
      bookingId: b.id,
      depositMode: "refund",
      reason: "Client unwell",
    });
    expect(domain.cancelBooking).toHaveBeenCalledWith(t.db, {
      bookingId: b.id,
      by: "staff",
      reason: "Client unwell",
      forceRefund: true,
    });
    expect(outcome.depositAction).toBe("refund");
    expect((await audits())[0]).toMatchObject({ action: "booking.cancelled_by_staff" });
  });

  test("keep mode leaves the policy to decide", async () => {
    const b = await addBooking();
    await cancelStaffBooking(ctx, { bookingId: b.id, depositMode: "keep" });
    expect(domain.cancelBooking.mock.calls[0][1]).toMatchObject({ forceRefund: false });
  });
});

describe("markBookingNoShow / resend / refund", () => {
  test("marks a no-show and audits the fee", async () => {
    const b = await addBooking();
    domain.markNoShow.mockResolvedValueOnce({
      bookingId: b.id,
      status: "no_show",
      depositAction: "keep",
      feeCents: 500,
    });
    const outcome = await markBookingNoShow(ctx, { bookingId: b.id });
    expect(outcome.feeCents).toBe(500);
    expect(domain.markNoShow).toHaveBeenCalledWith(t.db, b.id);
    const [audit] = await audits();
    expect(audit).toMatchObject({ action: "booking.no_show" });
    expect(audit.data).toMatchObject({ feeCents: 500 });
  });

  test("resends the confirmation and audits it", async () => {
    const b = await addBooking();
    await resendBookingConfirmation(ctx, { bookingId: b.id });
    expect(domain.resendConfirmation).toHaveBeenCalledWith(t.db, b.id);
    expect((await audits())[0]).toMatchObject({ action: "booking.confirmation_resent" });
  });

  test("refunds a payment, passing an optional partial amount, and audits it", async () => {
    const b = await addBooking();
    const paymentId = crypto.randomUUID();
    await refundBookingPayment(ctx, { bookingId: b.id, paymentId, amountCents: 2500 });
    expect(domain.refundPayment).toHaveBeenCalledWith(t.db, paymentId, 2500);
    const [audit] = await audits();
    expect(audit).toMatchObject({ action: "payment.refunded_by_staff", entityId: b.id });
    expect(audit.data).toMatchObject({ paymentId, amountCents: 2500 });
  });
});

describe("checkoutBooking", () => {
  async function addDeposit(bookingId: string, amountCents = 10000) {
    await t.db.insert(payment).values({
      bookingId,
      kind: "deposit",
      method: "stripe_online",
      status: "succeeded",
      amountCents,
    });
  }

  test("records the discounted cash balance then completes", async () => {
    const b = await addBooking();
    await addDeposit(b.id);

    const result = await checkoutBooking(ctx, { bookingId: b.id, method: "cash" });

    expect(result).toMatchObject({
      balanceDueCents: 10000,
      cashDiscountCents: 1000,
      payableCents: 9000,
      recordedPayment: true,
    });
    expect(domain.recordManualPayment).toHaveBeenCalledWith(t.db, {
      bookingId: b.id,
      method: "cash",
      amountCents: 9000,
      note: "Cash discount 10% (-$10.00)",
    });
    const order = [
      domain.recordManualPayment.mock.invocationCallOrder[0],
      domain.completeBooking.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
    expect(domain.completeBooking).toHaveBeenCalledWith(t.db, b.id);
    expect((await audits())[0]).toMatchObject({ action: "booking.checked_out" });
  });

  test("eftpos pays the full balance with no note", async () => {
    const b = await addBooking();
    await addDeposit(b.id);
    await checkoutBooking(ctx, { bookingId: b.id, method: "eftpos" });
    expect(domain.recordManualPayment).toHaveBeenCalledWith(t.db, {
      bookingId: b.id,
      method: "eftpos",
      amountCents: 10000,
      note: undefined,
    });
  });

  test("skips the payment when nothing is owed", async () => {
    const b = await addBooking();
    await addDeposit(b.id, 20000);
    const result = await checkoutBooking(ctx, { bookingId: b.id, method: "cash" });
    expect(result.recordedPayment).toBe(false);
    expect(domain.recordManualPayment).not.toHaveBeenCalled();
    expect(domain.completeBooking).toHaveBeenCalledOnce();
  });

  test("a retry after a failed completion does not charge the balance twice", async () => {
    const b = await addBooking();
    await addDeposit(b.id);
    await t.db.insert(payment).values({
      bookingId: b.id,
      kind: "balance",
      method: "cash",
      status: "succeeded",
      amountCents: 9000,
    });

    const result = await checkoutBooking(ctx, { bookingId: b.id, method: "cash" });
    expect(result.recordedPayment).toBe(false);
    expect(domain.recordManualPayment).not.toHaveBeenCalled();
    expect(domain.completeBooking).toHaveBeenCalledOnce();
  });

  test("refuses to check out a booking that is not confirmed", async () => {
    const done = await addBooking("completed");
    await expect(checkoutBooking(ctx, { bookingId: done.id, method: "cash" })).rejects.toThrow(
      /already completed/i,
    );
    const pending = await addBooking("pending_payment", {
      during: { start: new Date("2026-11-14T03:00:00Z"), end: new Date("2026-11-14T04:00:00Z") },
    });
    await expect(checkoutBooking(ctx, { bookingId: pending.id, method: "cash" })).rejects.toThrow(
      /not been confirmed/i,
    );
    await expect(
      checkoutBooking(ctx, { bookingId: crypto.randomUUID(), method: "cash" }),
    ).rejects.toThrow(/booking was not found/i);
    expect(domain.completeBooking).not.toHaveBeenCalled();
  });

  test("does not complete when recording the payment fails", async () => {
    const b = await addBooking();
    domain.recordManualPayment.mockRejectedValueOnce(new Error("db down"));
    await expect(checkoutBooking(ctx, { bookingId: b.id, method: "cash" })).rejects.toThrow(
      "db down",
    );
    expect(domain.completeBooking).not.toHaveBeenCalled();
  });
});

describe("mergeClientRecords", () => {
  test("merges the duplicate into the kept client and audits it", async () => {
    const [dup] = await t.db
      .insert(client)
      .values({ businessId: seed.biz.id, firstName: "Sam", lastName: "C" })
      .returning();
    await mergeClientRecords(ctx, { keepClientId: seed.cl.id, duplicateClientId: dup.id });
    expect(domain.mergeClients).toHaveBeenCalledWith(t.db, seed.cl.id, dup.id);
    const [audit] = await audits();
    expect(audit).toMatchObject({ action: "client.merged", entityId: seed.cl.id });
    expect(audit.data).toMatchObject({ duplicateClientId: dup.id });
  });

  test("cannot merge a client into itself", async () => {
    await expect(
      mergeClientRecords(ctx, { keepClientId: seed.cl.id, duplicateClientId: seed.cl.id }),
    ).rejects.toThrow(/itself/i);
  });
});
