/**
 * Props for every template. All values are display-ready strings (formatted in the business time
 * zone by the server layer) so the templates stay pure and trivially snapshot-testable.
 */

export interface PriceLineProp {
  name: string;
  price: string;
}

interface BaseProps {
  businessName: string;
  firstName: string;
  staffName: string;
}

interface AppointmentProps {
  dateLabel: string;
  timeLabel: string;
  services: PriceLineProp[];
  totalLabel: string;
  locationName: string;
  address: string;
  arrivalNote?: string;
}

export interface BookingConfirmationProps extends BaseProps, AppointmentProps {
  depositPaidLabel: string | null;
  balanceDueLabel: string;
  policyText: string;
  manageUrl: string;
  /** True when an .ics file is attached. */
  hasCalendarFile: boolean;
}

export interface BookingMovedProps extends BaseProps, AppointmentProps {
  previousDateLabel: string;
  previousTimeLabel: string;
  manageUrl: string;
  policyText: string;
  hasCalendarFile: boolean;
}

export type DepositOutcome = "refund" | "keep" | "none";

export interface FeeChargedProps extends BaseProps {
  dateLabel: string;
  timeLabel: string;
  locationName: string;
  kind: "no_show_fee" | "late_cancel_fee";
  /** Display amount charged to the card on file. */
  feeLabel: string;
  policyText: string;
}

export interface BookingCancelledProps extends BaseProps {
  dateLabel: string;
  timeLabel: string;
  services: PriceLineProp[];
  locationName: string;
  cancelledBy: "client" | "staff";
  depositOutcome: DepositOutcome;
  /** Display amount of the deposit the client paid, when there was one. */
  depositLabel: string | null;
  /** Extra fee charged to the card on file, when any. */
  feeLabel: string | null;
  policyText: string;
  rebookUrl: string;
}

export interface InvoiceEmailProps extends BaseProps {
  invoiceNumber: string;
  dateLabel: string;
  timeLabel: string;
  totalLabel: string;
}

export type OwnerAlertKind = "new" | "rescheduled" | "cancelled";

export interface OwnerAlertProps {
  businessName: string;
  kind: OwnerAlertKind;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  dateLabel: string;
  timeLabel: string;
  previousWhen: string | null;
  services: PriceLineProp[];
  totalLabel: string;
  locationName: string;
  depositLabel: string | null;
  /** Cancelled bookings: what happened to the deposit. */
  depositOutcome: DepositOutcome | null;
  comments: string | null;
}

export interface OneOffMessageProps {
  businessName: string;
  subject: string;
  /** Plain text; blank lines separate paragraphs. */
  body: string;
}
