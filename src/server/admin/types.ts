/**
 * Plain, serialisable shapes returned by the admin query functions. Dates are ISO-8601 UTC strings
 * so they cross the server/client boundary and JSON route handlers unchanged.
 */

export type BookingStatus =
  | "pending_payment"
  | "confirmed"
  | "completed"
  | "cancelled_by_client"
  | "cancelled_by_staff"
  | "late_cancelled"
  | "no_show"
  | "expired";

export type PaymentKind = "deposit" | "balance" | "no_show_fee" | "late_cancel_fee" | "refund";
export type PaymentMethod = "stripe_online" | "stripe_in_person" | "cash" | "eftpos" | "other";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded" | "partially_refunded";

/* Calendar ---------------------------------------------------------------- */

export interface CalendarBookingEvent {
  kind: "booking";
  id: string;
  start: string;
  end: string;
  staffId: string;
  locationId: string;
  status: BookingStatus;
  clientId: string;
  clientName: string;
  services: string[];
  totalCents: number;
  source: string;
}

export interface CalendarBlockEvent {
  /** `manual` blocks can be deleted; `external` blocks are imported Google busy time (read only). */
  kind: "block" | "external";
  id: string;
  start: string;
  end: string;
  staffId: string;
  reason: string | null;
}

export type CalendarEvent = CalendarBookingEvent | CalendarBlockEvent;

export interface CalendarResources {
  timezone: string;
  slotStepMin: number;
  locations: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; name: string }>;
  services: Array<{
    id: string;
    name: string;
    durationMin: number;
    priceCents: number;
    /** Locations offering the service. Empty means no restriction has been configured. */
    locationIds: string[];
  }>;
}

/* Booking detail ---------------------------------------------------------- */

export interface BookingDetailPayment {
  id: string;
  kind: PaymentKind;
  method: PaymentMethod;
  status: PaymentStatus;
  amountCents: number;
  note: string | null;
  createdAt: string;
}

export interface BookingDetail {
  id: string;
  status: BookingStatus;
  start: string;
  end: string;
  source: string;
  comments: string | null;
  bookedForOther: boolean;
  intakeAnswers: Record<string, string>;
  cancelReason: string | null;
  cancelledAt: string | null;
  location: { id: string; name: string };
  staff: { id: string; name: string };
  client: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    notes: string | null;
    blocked: boolean;
    isVip: boolean;
  };
  services: Array<{ id: string; name: string; durationMin: number; priceCents: number }>;
  totalCents: number;
  depositCents: number;
  /** Net of refunds. */
  paidCents: number;
  /** Zero once the booking is completed (any cash discount is treated as settled). */
  balanceDueCents: number;
  payments: BookingDetailPayment[];
  messages: Array<{
    id: string;
    channel: "email" | "sms";
    template: string;
    status: "queued" | "sent" | "delivered" | "failed";
    toAddress: string;
    error: string | null;
    createdAt: string;
    sentAt: string | null;
  }>;
  audit: Array<{
    id: string;
    actor: string;
    action: string;
    data: Record<string, unknown>;
    at: string;
  }>;
  /** What the owner may do right now. */
  allowed: {
    move: boolean;
    cancel: boolean;
    noShow: boolean;
    checkout: boolean;
    resend: boolean;
  };
}

/* Lists ------------------------------------------------------------------- */

export type BookingListFilter = "upcoming" | "past" | "cancelled";

export interface BookingListRow {
  id: string;
  start: string;
  end: string;
  status: BookingStatus;
  clientId: string;
  clientName: string;
  locationName: string;
  services: string[];
  totalCents: number;
}

export interface ClientSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isVip: boolean;
  blocked: boolean;
}

export interface ClientProfile {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string | null;
  phone: string | null;
  pronouns: string | null;
  notes: string | null;
  blocked: boolean;
  isVip: boolean;
  marketingOptIn: boolean;
  createdAt: string;
  /** Set when this record was merged into another client; callers should redirect there. */
  mergedIntoId: string | null;
  stats: {
    completedCount: number;
    noShowCount: number;
    lateCancelCount: number;
    cancelledCount: number;
    upcomingCount: number;
    lifetimeSpendCents: number;
  };
  history: BookingListRow[];
}

/* Checkout ---------------------------------------------------------------- */

export interface CheckoutView {
  bookingId: string;
  status: BookingStatus;
  start: string;
  clientName: string;
  locationName: string;
  services: Array<{ name: string; priceCents: number }>;
  totalCents: number;
  paidCents: number;
  cashDiscountPct: number;
  /** A balance payment already exists (checkout was started before); completing will not charge again. */
  balanceAlreadyRecorded: boolean;
  /** Present once the booking is completed, for the receipt. */
  receipt: {
    payments: BookingDetailPayment[];
    paidCents: number;
  } | null;
}
