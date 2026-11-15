/**
 * OWNER: workstream A (domain core). Booking lifecycle: hold, confirm, expire, cancel, reschedule,
 * no-show, complete, and the public token lookup. Every state change writes an audit row and emits
 * its domain event inside the same transaction. Refunds and fees are NOT performed here: the payments
 * consumer reacts to booking.cancelled / booking.no_show.
 */
export { reassignBooking } from "./reassign";
export { cancelBooking } from "./cancel";
export { createHold } from "./create-hold";
export { completeBooking, confirmBooking, expireHolds, markNoShow } from "./lifecycle";
export { getBookingByToken } from "./lookup";
export { rescheduleBooking } from "./reschedule";
export {
  BookingStateError,
  ChangeWindowError,
  ClientBlockedError,
  ClientMergeError,
  DomainError,
  HoldExpiredError,
  NotFoundError,
  NotRosteredError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
  VipOnlyError,
} from "./errors";
export type { BookingOptions } from "./shared";
