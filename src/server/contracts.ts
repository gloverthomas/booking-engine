/**
 * Shared types between workstreams. Implementations live in src/server/<area>/index.ts.
 * Do not change an existing signature without telling the integrator; adding optional fields is fine.
 */

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface AvailabilityQuery {
  locationId: string;
  /** Omit for "first available stylist". */
  staffId?: string;
  serviceIds: string[];
  /** Local calendar dates (YYYY-MM-DD) in the business timezone, inclusive. */
  fromDate: string;
  toDate: string;
  now?: Date;
}

export interface AvailableSlot extends TimeSlot {
  staffId: string;
  /** Total for the selected services at this stylist's price (own or level pricing applied). */
  totalCents?: number;
  /** Total length of the selected services for this stylist, in minutes (excludes the buffer). */
  durationMin?: number;
}

export interface ClientInput {
  firstName: string;
  lastName: string;
  /** Optional for staff-created bookings; online booking requires it. */
  email?: string;
  /** E.164 after normalisation. */
  phone: string;
  pronouns?: string;
  marketingOptIn?: boolean;
}

export interface CreateHoldInput {
  locationId: string;
  staffId?: string;
  serviceIds: string[];
  start: Date;
  client: ClientInput;
  bookedForOther?: boolean;
  comments?: string;
  intakeAnswers?: Record<string, string>;
  /** True when the client chose this stylist rather than "first available". */
  staffRequested?: boolean;
  /** The policy version the client ticked. Must equal the current settings.policyVersion. */
  policyVersion: string;
  source?: string;
  now?: Date;
}

export interface HoldResult {
  bookingId: string;
  /** Stateless manage-booking token (see src/server/manage-token.ts). Safe to rebuild any time from the booking id. */
  manageToken: string;
  holdExpiresAt: Date;
  totalCents: number;
  depositCents: number;
  during: TimeSlot;
}

export type CancelledBy = "client" | "staff";

export interface CancelInput {
  bookingId: string;
  by: CancelledBy;
  reason?: string;
  /** Staff only: override the policy (e.g. always refund). */
  forceRefund?: boolean;
  /** Staff only: keep the deposit instead of refunding it (no extra fee). Ignored when forceRefund is set. */
  keepDeposit?: boolean;
  now?: Date;
}

export interface CancelOutcome {
  bookingId: string;
  status: "cancelled_by_client" | "cancelled_by_staff" | "late_cancelled" | "no_show";
  depositAction: "refund" | "keep" | "none";
  /** Extra fee to charge the saved card (0 when none). */
  feeCents: number;
}

export interface RescheduleInput {
  bookingId: string;
  newStart: Date;
  by: CancelledBy;
  notifyClient?: boolean;
  now?: Date;
}

export interface ReassignInput {
  bookingId: string;
  newStaffId: string;
  /** Tell the client their stylist changed. */
  notifyClient?: boolean;
  /** "owner:<userId>" etc. for the audit trail. */
  actor?: string;
  now?: Date;
}

export interface PaymentIntentResult {
  paymentId: string;
  clientSecret: string;
  amountCents: number;
}

export interface PublicBookingSummary {
  bookingId: string;
  status: string;
  start: Date;
  end: Date;
  locationName: string;
  services: Array<{ name: string; priceCents: number }>;
  totalCents: number;
  depositCents: number;
}

/* ---------------------------------- Staff ---------------------------------- */

export type StaffRole = "owner" | "manager" | "stylist" | "reception";

/* --------------------------------- Waitlist -------------------------------- */

export interface WaitlistJoinInput {
  client: ClientInput;
  locationId: string;
  /** Omit for any stylist who offers all the services. */
  staffId?: string;
  serviceIds: string[];
  /** Local dates (YYYY-MM-DD), inclusive. */
  earliestDate: string;
  latestDate: string;
  /** 0 = Sunday ... 6 = Saturday. Omit for any day. */
  weekdays?: number[];
  /** Business-local minutes the appointment must start within. Omit for any time. */
  fromMinute?: number;
  toMinute?: number;
  notes?: string;
  now?: Date;
}

export interface WaitlistOfferInput {
  entryId: string;
  staffId: string;
  during: TimeSlot;
  /** "auto" or "owner:<userId>". */
  offeredBy: string;
  now?: Date;
}

export interface WaitlistOfferSummary {
  offerId: string;
  entryId: string;
  start: Date;
  end: Date;
  locationName: string;
  services: Array<{ name: string; priceCents: number }>;
  depositCents: number;
  expiresAt: Date;
  /** sent = can still be claimed. */
  status: "sent" | "claimed" | "expired" | "slot_taken" | "cancelled";
}
