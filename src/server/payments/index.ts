/** OWNER: workstream C (payments). Public surface of the payments module. */
export { createDepositIntent } from "./deposit";
export { refundPayment } from "./refund";
export { chargeSavedCard, recordManualPayment } from "./charge";
export { processStripeEvent, type WebhookOutcome } from "./webhook";
export { refundOrphanedDeposits } from "./orphans";
export {
  PaymentError,
  getStripe,
  getWebhookSecret,
  type PaymentDeps,
  type PaymentErrorCode,
  type StripeEventLike,
  type StripeLike,
} from "./stripe";
