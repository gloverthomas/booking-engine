/**
 * OWNER: workstream W6 (waitlist). Join, offer, claim and expire. Offers go out automatically when a
 * slot frees up (settings.waitlistAutoOffer) and the owner can always offer one by hand; whoever claims
 * and pays the deposit first gets the time. Every state change writes an audit row and emits its domain
 * event inside the same transaction.
 */
export { joinWaitlist, cancelWaitlistEntry, MAX_ACTIVE_ENTRIES_PER_CLIENT } from "./join";
export { createWaitlistOffer, offerFreedSlot, type FreedSlot } from "./offers";
export {
  claimOffer,
  getOfferByToken,
  getOfferView,
  loadBillingDetails,
  type BillingDetails,
  type ClaimOptions,
  type WaitlistOfferView,
} from "./claim";
export { expireWaitlist, revertIdleEntries } from "./expire";
export {
  getEntryByToken,
  leaveWaitlistByToken,
  makeLeaveToken,
  type WaitlistEntryView,
} from "./entry";
export { handleWaitlistEvent, type WaitlistEventContext } from "./consumer";
export { OfferGoneError, WaitlistDisabledError } from "./errors";
export type { WaitlistOptions } from "./shared";
export {
  listOfferableSlots,
  listWaitlist,
  type AdminEntryRow,
  type AdminOfferRow,
  type OfferableSlot,
  type OfferableSlots,
  type WaitlistView,
} from "./admin";
export { offerSlot, removeEntry, offerSlotSchema, removeEntrySchema } from "./admin-commands";
