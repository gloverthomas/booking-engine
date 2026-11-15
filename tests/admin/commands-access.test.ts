import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { createService, createStaff, seedBasics } from "../helpers/factories";
import { auditLog, booking, payment, staff } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { AccessContext } from "@/server/admin/access";
import {
  cancelStaffBooking,
  checkoutBooking,
  createStaffBooking,
  markBookingNoShow,
  mergeClientRecords,
  reassignStaffBooking,
  refundBookingPayment,
  resendBookingConfirmation,
  rescheduleStaffBooking,
  type CommandContext,
} from "@/server/admin/commands";
import type { AdminDomain } from "@/server/admin/domain";
import { DomainError } from "@/server/booking/errors";
import type { StaffRole } from "@/server/contracts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let alex: typeof staff.$inferSelect;
let blake: typeof staff.$inferSelect;
let alexBooking: typeof booking.$inferSelect;
let blakeBooking: typeof booking.$inferSelect;
let domain: { [K in keyof AdminDomain]: ReturnType<typeof vi.fn> };

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
    reassignBooking: vi.fn(async () => undefined),
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

function ctxFor(role: StaffRole, staffId: string | null): CommandContext {
  const access: AccessContext = { role, staffId };
  return {
    db: t.db,
    actor: role === "owner" ? "owner:u1" : "staff:u2",
    access,
    domain: domain as unknown as AdminDomain,
    now: NOW,
  };
}

const asOwner = () => ctxFor("owner", null);
const asManager = () => ctxFor("manager", null);
const asReception = () => ctxFor("reception", null);
const asAlex = () => ctxFor("stylist", alex.id);

async function addBooking(staffId: string, start: string) {
  const [row] = await t.db
    .insert(booking)
    .values({
      staffId,
      locationId: seed.loc.id,
      clientId: seed.cl.id,
      status: "confirmed",
      during: { start: new Date(start), end: new Date(new Date(start).getTime() + 3_600_000) },
      totalCents: 20000,
      depositCents: 0,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
  alex = await createStaff(t.db, seed.biz.id, { name: "Alex", email: "a@example.com" });
  blake = await createStaff(t.db, seed.biz.id, { name: "Blake", email: "b@example.com" });
  alexBooking = await addBooking(alex.id, "2026-11-16T03:00:00Z");
  blakeBooking = await addBooking(blake.id, "2026-11-16T05:00:00Z");
  domain = makeDomain();
});
afterEach(async () => {
  await t.client.close();
});

describe("a stylist cannot touch a colleague's booking", () => {
  const notFound = /booking was not found/i;

  test("move, cancel, no-show, resend and check out are all refused and nothing reaches the domain", async () => {
    const ctx = asAlex();
    const id = blakeBooking.id;
    await expect(
      rescheduleStaffBooking(ctx, { bookingId: id, newStart: NOW, notifyClient: false }),
    ).rejects.toThrow(notFound);
    await expect(
      cancelStaffBooking(ctx, { bookingId: id, depositMode: "keep" }),
    ).rejects.toThrow(notFound);
    await expect(markBookingNoShow(ctx, { bookingId: id })).rejects.toThrow(notFound);
    await expect(resendBookingConfirmation(ctx, { bookingId: id })).rejects.toThrow(notFound);
    await expect(checkoutBooking(ctx, { bookingId: id, method: "cash" })).rejects.toThrow(notFound);

    expect(domain.rescheduleBooking).not.toHaveBeenCalled();
    expect(domain.cancelBooking).not.toHaveBeenCalled();
    expect(domain.markNoShow).not.toHaveBeenCalled();
    expect(domain.resendConfirmation).not.toHaveBeenCalled();
    expect(domain.completeBooking).not.toHaveBeenCalled();
    expect(domain.recordManualPayment).not.toHaveBeenCalled();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  test("a nonexistent booking gets the identical answer", async () => {
    await expect(
      cancelStaffBooking(asAlex(), { bookingId: crypto.randomUUID(), depositMode: "keep" }),
    ).rejects.toThrow(notFound);
  });

  test("the same actions work on their own booking", async () => {
    const ctx = asAlex();
    const id = alexBooking.id;
    await rescheduleStaffBooking(ctx, { bookingId: id, newStart: NOW, notifyClient: false });
    await cancelStaffBooking(ctx, { bookingId: id, depositMode: "keep" });
    await markBookingNoShow(ctx, { bookingId: id });
    await resendBookingConfirmation(ctx, { bookingId: id });
    await checkoutBooking(ctx, { bookingId: id, method: "cash" });
    expect(domain.rescheduleBooking).toHaveBeenCalledOnce();
    expect(domain.completeBooking).toHaveBeenCalledOnce();
  });

  test("reception and managers may act on any stylist's booking", async () => {
    await checkoutBooking(asReception(), { bookingId: blakeBooking.id, method: "eftpos" });
    await cancelStaffBooking(asManager(), { bookingId: alexBooking.id, depositMode: "refund" });
    expect(domain.completeBooking).toHaveBeenCalledWith(t.db, blakeBooking.id);
    expect(domain.cancelBooking).toHaveBeenCalledOnce();
  });
});

describe("audit actor", () => {
  test("owners are owner:<id>, everyone else staff:<id>", async () => {
    await resendBookingConfirmation(asOwner(), { bookingId: alexBooking.id });
    await resendBookingConfirmation(asAlex(), { bookingId: alexBooking.id });
    const actors = (await t.db.select().from(auditLog)).map((a) => a.actor).sort();
    expect(actors).toEqual(["owner:u1", "staff:u2"]);
  });
});

describe("refunds are owner only", () => {
  async function addPayment(bookingId: string) {
    const [row] = await t.db
      .insert(payment)
      .values({
        bookingId,
        kind: "deposit",
        method: "stripe_online",
        status: "succeeded",
        amountCents: 5000,
      })
      .returning();
    return row;
  }

  test("stylist, reception and manager are denied; the owner succeeds", async () => {
    const paid = await addPayment(alexBooking.id);
    for (const ctx of [asAlex(), asReception(), asManager()]) {
      await expect(
        refundBookingPayment(ctx, { bookingId: alexBooking.id, paymentId: paid.id }),
      ).rejects.toThrow(/permission/i);
    }
    expect(domain.refundPayment).not.toHaveBeenCalled();
    await refundBookingPayment(asOwner(), { bookingId: alexBooking.id, paymentId: paid.id });
    expect(domain.refundPayment).toHaveBeenCalledWith(t.db, paid.id, undefined);
  });

  test("a payment that belongs to another booking cannot be refunded through this one", async () => {
    const other = await addPayment(blakeBooking.id);
    await expect(
      refundBookingPayment(asOwner(), { bookingId: alexBooking.id, paymentId: other.id }),
    ).rejects.toThrow(/payment was not found/i);
  });
});

describe("merging clients is for managers and the owner", () => {
  const ids = () => ({ keepClientId: crypto.randomUUID(), duplicateClientId: crypto.randomUUID() });

  test("stylists and reception are denied", async () => {
    await expect(mergeClientRecords(asAlex(), ids())).rejects.toThrow(/permission/i);
    await expect(mergeClientRecords(asReception(), ids())).rejects.toThrow(/permission/i);
    expect(domain.mergeClients).not.toHaveBeenCalled();
  });

  test("managers and the owner may merge", async () => {
    await mergeClientRecords(asManager(), ids());
    await mergeClientRecords(asOwner(), ids());
    expect(domain.mergeClients).toHaveBeenCalledTimes(2);
  });
});

describe("creating a booking", () => {
  async function create(ctx: CommandContext, staffId?: string) {
    const svc = await createService(t.db, seed.biz.id);
    return createStaffBooking(ctx, {
      locationId: seed.loc.id,
      staffId,
      serviceIds: [svc.id],
      start: new Date("2026-11-18T03:00:00Z"),
      client: { existingClientId: seed.cl.id },
      notifyClient: false,
    });
  }

  test("a stylist always books into their own column and it counts as requested", async () => {
    await create(asAlex());
    expect(domain.createHold.mock.calls[0][1]).toMatchObject({
      staffId: alex.id,
      staffRequested: true,
    });
  });

  test("a stylist cannot book into a colleague's column", async () => {
    await expect(create(asAlex(), blake.id)).rejects.toThrow(/permission/i);
    expect(domain.createHold).not.toHaveBeenCalled();
  });

  test("first available leaves staffRequested false, a named person sets it true", async () => {
    await create(asReception());
    expect(domain.createHold.mock.calls[0][1]).toMatchObject({
      staffId: undefined,
      staffRequested: false,
    });
    await create(asManager(), blake.id);
    expect(domain.createHold.mock.calls[1][1]).toMatchObject({
      staffId: blake.id,
      staffRequested: true,
    });
  });
});

describe("reassigning a booking", () => {
  const input = (newStaffId: string) => ({
    bookingId: alexBooking.id,
    newStaffId,
    notifyClient: true,
  });

  test("stylists cannot hand bookings over, even their own", async () => {
    await expect(reassignStaffBooking(asAlex(), input(blake.id))).rejects.toThrow(/permission/i);
    expect(domain.reassignBooking).not.toHaveBeenCalled();
  });

  test("managers, reception and the owner can, and it is audited with the actor", async () => {
    await reassignStaffBooking(asManager(), input(blake.id));
    await reassignStaffBooking(asReception(), input(blake.id));
    await reassignStaffBooking(asOwner(), input(blake.id));
    expect(domain.reassignBooking).toHaveBeenCalledTimes(3);
    expect(domain.reassignBooking).toHaveBeenCalledWith(t.db, {
      bookingId: alexBooking.id,
      newStaffId: blake.id,
      notifyClient: true,
      actor: "staff:u2",
      now: NOW,
    });
    const audits = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === "booking.stylist_changed",
    );
    expect(audits).toHaveLength(3);
    expect(audits[0].data).toMatchObject({ fromStaffId: alex.id, toStaffId: blake.id });
  });

  test("refuses the same stylist and unavailable stylists before calling the domain", async () => {
    await expect(reassignStaffBooking(asOwner(), input(alex.id))).rejects.toThrow(
      /already with that stylist/i,
    );
    await t.db.update(staff).set({ active: false }).where(eq(staff.id, blake.id));
    await expect(reassignStaffBooking(asOwner(), input(blake.id))).rejects.toThrow(
      /not available/i,
    );
    await expect(reassignStaffBooking(asOwner(), input(crypto.randomUUID()))).rejects.toThrow(
      /not available/i,
    );
    expect(domain.reassignBooking).not.toHaveBeenCalled();
  });

  test("a domain refusal (not rostered, busy, wrong services) becomes a clear message and no audit", async () => {
    domain.reassignBooking.mockRejectedValueOnce(new DomainError("They are not rostered then"));
    await expect(reassignStaffBooking(asOwner(), input(blake.id))).rejects.toThrow(
      "Blake cannot take this booking: They are not rostered then",
    );
    domain.reassignBooking.mockRejectedValueOnce(
      Object.assign(new Error("conflicting key value violates exclusion constraint"), {
        code: "23P01",
      }),
    );
    await expect(reassignStaffBooking(asOwner(), input(blake.id))).rejects.toThrow(
      /Blake is already busy/,
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  test("an unexpected failure is not disguised", async () => {
    domain.reassignBooking.mockRejectedValueOnce(new Error("boom"));
    await expect(reassignStaffBooking(asOwner(), input(blake.id))).rejects.toThrow("boom");
  });
});
