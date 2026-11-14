import type {
  CancelInput,
  CancelOutcome,
  CreateHoldInput,
  HoldResult,
  PublicBookingSummary,
  RescheduleInput,
} from "../contracts";
import type { Db } from "../db-types";

/** OWNER: workstream A (domain core). Replace these stubs; keep the signatures. */

export async function createHold(_db: Db, _input: CreateHoldInput): Promise<HoldResult> {
  throw new Error("createHold not implemented");
}

/** Called by payments once the deposit has succeeded (or immediately when depositCents is 0). */
export async function confirmBooking(_db: Db, _bookingId: string, _now?: Date): Promise<void> {
  throw new Error("confirmBooking not implemented");
}

/** Expire pending bookings whose hold has lapsed. Returns how many were expired. */
export async function expireHolds(_db: Db, _now?: Date): Promise<number> {
  throw new Error("expireHolds not implemented");
}

export async function cancelBooking(_db: Db, _input: CancelInput): Promise<CancelOutcome> {
  throw new Error("cancelBooking not implemented");
}

export async function rescheduleBooking(_db: Db, _input: RescheduleInput): Promise<void> {
  throw new Error("rescheduleBooking not implemented");
}

export async function markNoShow(_db: Db, _bookingId: string, _now?: Date): Promise<CancelOutcome> {
  throw new Error("markNoShow not implemented");
}

export async function completeBooking(_db: Db, _bookingId: string, _now?: Date): Promise<void> {
  throw new Error("completeBooking not implemented");
}

/** Lookup for the public manage-booking page. Returns null for an unknown or invalid token. */
export async function getBookingByToken(
  _db: Db,
  _rawToken: string,
): Promise<PublicBookingSummary | null> {
  throw new Error("getBookingByToken not implemented");
}
