/** Wire types for the public booking API. Shared by route handlers and the browser client. */

export interface ApiErrorBody {
  code: string;
  message: string;
  /** Field name (dot path) to a human message, for form validation failures. */
  fieldErrors?: Record<string, string>;
}

export type ApiEnvelope<T> = { success: true; data: T } | { success: false; error: ApiErrorBody };

export interface IntakeQuestion {
  id: string;
  label: string;
  required: boolean;
}

export interface CatalogService {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  durationMin: number;
  priceCents: number;
  /** Effective deposit percentage (service override or the business default). */
  depositPct: number;
  intakeQuestions: IntakeQuestion[];
}

export interface CatalogLocation {
  id: string;
  name: string;
  addressLine: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  arrivalNote: string | null;
  services: CatalogService[];
}

export interface CatalogPolicy {
  version: string;
  text: string;
  cancelWindowHours: number;
  depositPct: number;
  refundOutsideWindow: "refund" | "credit";
}

export interface CatalogData {
  business: { name: string; timezone: string };
  /** Today's date in the business time zone, YYYY-MM-DD. */
  today: string;
  maxAdvanceDays: number;
  holdMinutes: number;
  policy: CatalogPolicy;
  locations: CatalogLocation[];
}

export interface SlotDto {
  /** ISO instant (UTC). */
  start: string;
  end: string;
  /** Local label in the business zone, e.g. "2:30 pm". */
  label: string;
}

export interface AvailabilityDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  morning: SlotDto[];
  afternoon: SlotDto[];
}

export interface AvailabilityData {
  timezone: string;
  fromDate: string;
  toDate: string;
  /** Only days that have at least one slot, ascending. */
  days: AvailabilityDay[];
}

export interface HoldPayment {
  clientSecret: string;
  paymentId: string;
  amountCents: number;
}

export interface HoldData {
  bookingId: string;
  manageToken: string;
  holdExpiresAt: string;
  /** Server clock when the response was produced, to correct for client clock skew. */
  serverNow: string;
  totalCents: number;
  depositCents: number;
  start: string;
  end: string;
  /** True when no deposit was due and the booking is already confirmed. */
  confirmed: boolean;
  payment: HoldPayment | null;
}

export type DepositOutcome = "refund" | "credit" | "keep" | "none";

export interface CancellationInfo {
  canCancel: boolean;
  canReschedule: boolean;
  /** True when the appointment is inside the cancellation window. */
  withinWindow: boolean;
  windowHours: number;
  /** ISO instant after which the deposit is forfeited. */
  deadline: string;
  depositOutcome: DepositOutcome;
  /** Plain-language consequence of cancelling right now. */
  cancelMessage: string;
  /** Why changes are unavailable (null when they are available). */
  blockedReason: string | null;
}

export interface ManageBookingData {
  booking: {
    bookingId: string;
    status: string;
    start: string;
    end: string;
    locationName: string;
    services: Array<{ name: string; priceCents: number }>;
    totalCents: number;
    depositCents: number;
  };
  location: {
    id: string;
    name: string;
    address: string | null;
    arrivalNote: string | null;
    phone: string | null;
  };
  serviceIds: string[];
  businessName: string;
  timezone: string;
  now: string;
  maxAdvanceDays: number;
  cancellation: CancellationInfo;
}

export interface CancelData {
  status: "cancelled_by_client" | "late_cancelled";
  depositAction: "refund" | "keep" | "none";
  message: string;
}

export interface RescheduleData {
  start: string;
  end: string;
}
