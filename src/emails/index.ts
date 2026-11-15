import { createElement, type ReactElement } from "react";
import { render } from "@react-email/render";
import { BookingCancelled, cancelledSubject } from "./BookingCancelled";
import { BookingConfirmation, confirmationSubject } from "./BookingConfirmation";
import { BookingMoved, movedSubject } from "./BookingMoved";
import { FeeCharged, feeChargedSubject } from "./FeeCharged";
import { InvoiceEmail, invoiceSubject } from "./InvoiceEmail";
import { OneOffMessage } from "./OneOffMessage";
import { OwnerAlert, ownerAlertSubject } from "./OwnerAlert";
import { StaffAlert, staffAlertSubject } from "./StaffAlert";
import type {
  BookingCancelledProps,
  BookingConfirmationProps,
  BookingMovedProps,
  FeeChargedProps,
  InvoiceEmailProps,
  OneOffMessageProps,
  OwnerAlertProps,
  StaffAlertProps,
} from "./props";

export type * from "./props";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders a template to HTML plus a plain-text alternative derived from the same tree, so the two
 * can never drift apart. `@react-email/render` is the maintained renderer (the
 * `@react-email/components` package is deprecated, and we do not need it: our components are
 * plain React with inline styles).
 */
async function renderTemplate(subject: string, element: ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text };
}

export function renderBookingConfirmation(p: BookingConfirmationProps): Promise<RenderedEmail> {
  return renderTemplate(confirmationSubject(p), createElement(BookingConfirmation, p));
}

export function renderBookingMoved(p: BookingMovedProps): Promise<RenderedEmail> {
  return renderTemplate(movedSubject(p), createElement(BookingMoved, p));
}

export function renderBookingCancelled(p: BookingCancelledProps): Promise<RenderedEmail> {
  return renderTemplate(cancelledSubject(p), createElement(BookingCancelled, p));
}

export function renderFeeCharged(p: FeeChargedProps): Promise<RenderedEmail> {
  return renderTemplate(feeChargedSubject(p), createElement(FeeCharged, p));
}

export function renderInvoiceEmail(p: InvoiceEmailProps): Promise<RenderedEmail> {
  return renderTemplate(invoiceSubject(p), createElement(InvoiceEmail, p));
}

export function renderOwnerAlert(p: OwnerAlertProps): Promise<RenderedEmail> {
  return renderTemplate(ownerAlertSubject(p), createElement(OwnerAlert, p));
}

export function renderStaffAlert(p: StaffAlertProps): Promise<RenderedEmail> {
  return renderTemplate(staffAlertSubject(p), createElement(StaffAlert, p));
}

export function renderOneOffMessage(p: OneOffMessageProps): Promise<RenderedEmail> {
  return renderTemplate(p.subject, createElement(OneOffMessage, p));
}
