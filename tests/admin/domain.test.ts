import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/server/db-types";

vi.mock("@/server/booking", () => ({
  createHold: vi.fn(async () => "hold"),
  confirmBooking: vi.fn(async () => "confirm"),
  cancelBooking: vi.fn(async () => "cancel"),
  rescheduleBooking: vi.fn(async () => "reschedule"),
  markNoShow: vi.fn(async () => "noshow"),
  completeBooking: vi.fn(async () => "complete"),
}));
vi.mock("@/server/payments", () => ({
  recordManualPayment: vi.fn(async () => "record"),
  refundPayment: vi.fn(async () => "refund"),
}));
vi.mock("@/server/notifications", () => ({ resendConfirmation: vi.fn(async () => "resend") }));

import * as booking from "@/server/booking";
import * as payments from "@/server/payments";
import * as notifications from "@/server/notifications";
import { realDomain } from "@/server/admin/domain";

const db = {} as Db;

describe("realDomain delegates to the owning modules", () => {
  beforeEach(() => vi.clearAllMocks());

  test("booking lifecycle", async () => {
    const hold = { locationId: "l" } as never;
    await realDomain.createHold(db, hold);
    await realDomain.confirmBooking(db, "b");
    const cancel = { bookingId: "b", by: "staff" } as never;
    await realDomain.cancelBooking(db, cancel);
    const move = { bookingId: "b" } as never;
    await realDomain.rescheduleBooking(db, move);
    await realDomain.markNoShow(db, "b");
    await realDomain.completeBooking(db, "b");

    expect(booking.createHold).toHaveBeenCalledWith(db, hold);
    expect(booking.confirmBooking).toHaveBeenCalledWith(db, "b");
    expect(booking.cancelBooking).toHaveBeenCalledWith(db, cancel);
    expect(booking.rescheduleBooking).toHaveBeenCalledWith(db, move);
    expect(booking.markNoShow).toHaveBeenCalledWith(db, "b");
    expect(booking.completeBooking).toHaveBeenCalledWith(db, "b");
  });

  test("payments and notifications", async () => {
    const manual = { bookingId: "b", method: "cash", amountCents: 1 } as const;
    await realDomain.recordManualPayment(db, manual);
    await realDomain.refundPayment(db, "p", 5);
    await realDomain.resendConfirmation(db, "b");

    expect(payments.recordManualPayment).toHaveBeenCalledWith(db, manual);
    expect(payments.refundPayment).toHaveBeenCalledWith(db, "p", 5);
    expect(notifications.resendConfirmation).toHaveBeenCalledWith(db, "b");
  });

  test("mergeClients is a guarded placeholder until the clients module merges", async () => {
    await expect(realDomain.mergeClients(db, "a", "b")).rejects.toThrow();
  });
});
