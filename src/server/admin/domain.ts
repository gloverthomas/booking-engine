import type {
  CancelInput,
  CancelOutcome,
  CreateHoldInput,
  HoldResult,
  ReassignInput,
  RescheduleInput,
} from "../contracts";
import type { Db } from "../db-types";
import {
  reassignBooking,
  cancelBooking,
  completeBooking,
  confirmBooking,
  createHold,
  markNoShow,
  rescheduleBooking,
} from "../booking";
import { mergeClients } from "../clients";
import { recordManualPayment, refundPayment } from "../payments";
import { resendConfirmation } from "../notifications";

/**
 * Thin seam over the other workstreams' functions. Admin commands depend on this interface, so tests
 * pass fakes and the real modules arrive at merge without touching the command code.
 */
export interface AdminDomain {
  createHold(db: Db, input: CreateHoldInput): Promise<HoldResult>;
  confirmBooking(db: Db, bookingId: string, options?: { notifyClient?: boolean }): Promise<void>;
  cancelBooking(db: Db, input: CancelInput): Promise<CancelOutcome>;
  rescheduleBooking(db: Db, input: RescheduleInput): Promise<void>;
  /** Hand a confirmed, future booking to another stylist. Throws when they are not rostered, free or qualified. */
  reassignBooking(db: Db, input: ReassignInput): Promise<void>;
  markNoShow(db: Db, bookingId: string): Promise<CancelOutcome>;
  completeBooking(db: Db, bookingId: string): Promise<void>;
  recordManualPayment(
    db: Db,
    input: {
      bookingId: string;
      method: "cash" | "eftpos" | "other";
      amountCents: number;
      note?: string;
    },
  ): Promise<void>;
  refundPayment(db: Db, paymentId: string, amountCents?: number): Promise<void>;
  resendConfirmation(db: Db, bookingId: string): Promise<void>;
  /** Merge `duplicateClientId` into `keepClientId` (bookings, payments and messages move across). */
  mergeClients(db: Db, keepClientId: string, duplicateClientId: string): Promise<void>;
}

export const realDomain: AdminDomain = {
  createHold: (db, input) => createHold(db, input),
  confirmBooking: (db, bookingId, options) => confirmBooking(db, bookingId, new Date(), options),
  cancelBooking: (db, input) => cancelBooking(db, input),
  rescheduleBooking: (db, input) => rescheduleBooking(db, input),
  reassignBooking: (db, input) => reassignBooking(db, input),
  markNoShow: (db, bookingId) => markNoShow(db, bookingId),
  completeBooking: (db, bookingId) => completeBooking(db, bookingId),
  recordManualPayment: (db, input) => recordManualPayment(db, input),
  refundPayment: (db, paymentId, amountCents) => refundPayment(db, paymentId, amountCents),
  resendConfirmation: (db, bookingId) => resendConfirmation(db, bookingId),
  // A's mergeClients takes (db, fromId = duplicate, toId = survivor).
  mergeClients: (db, keepClientId, duplicateClientId) =>
    mergeClients(db, duplicateClientId, keepClientId),
};
