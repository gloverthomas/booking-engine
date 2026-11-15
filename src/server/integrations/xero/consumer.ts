import { isImportedSource } from "@/server/import/constants";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import { sendInvoiceEmail } from "@/server/notifications";
import { getBusiness, recordFailure, recordSuccess } from "../common/account-store";
import {
  clientFullName,
  LIVE_STATUSES,
  loadBookingBundle,
  type BookingBundle,
  type ClientRow,
} from "../common/booking-data";
import { AuthRevokedError, errorMessage, isRetryable, NotConnectedError } from "../common/errors";
import { claimOnce, markProcessed } from "../common/once";
import { accountCodeForMethod } from "./config";
import { amountTypesFor, invoiceLines, localDate, singleLine } from "./invoice-mapper";
import {
  loadXeroRuntime,
  XERO_RECONNECT_MESSAGE,
  type XeroDeps,
  type XeroRuntime,
} from "./runtime";

/** Shape of what the relay publishes: `{ eventId, type, ...payload }`. */
export interface IncomingXeroEvent {
  eventId?: string;
  type: string;
  bookingId?: string;
  paymentId?: string;
}

export interface XeroConsumerDeps extends XeroDeps {
  /** Injected in tests; defaults to the notifications module. */
  sendInvoiceEmail?: typeof sendInvoiceEmail;
}

type PaymentRow = typeof payment.$inferSelect;
/** `notes` collects non-fatal problems (e.g. the invoice email failed) to show on the account. */
type Ctx = { deps: XeroConsumerDeps; rt: XeroRuntime; timezone: string; notes: string[] };

const HANDLED = new Set([
  "booking.confirmed",
  "booking.cancelled",
  "booking.no_show",
  "booking.completed",
  "payment.succeeded",
  "payment.refunded",
]);
const SETTLED_STATUSES: ReadonlyArray<PaymentRow["status"]> = [
  "succeeded",
  "partially_refunded",
  "refunded",
];

const emailClaimKey = (bookingId: string): string => `invoice-email:${bookingId}`;

/* -------------------------------------------------------------------------- */
/* Contact + invoice                                                          */
/* -------------------------------------------------------------------------- */

/** Match an existing Xero contact by email, else create one; remember the id on the client. */
async function ensureContact({ deps, rt }: Ctx, c: ClientRow): Promise<string> {
  if (c.xeroContactId) return c.xeroContactId;
  const email = c.email?.trim().toLowerCase();
  const existing = email ? await rt.port.findContactByEmail(email) : null;
  const contactId =
    existing?.contactId ??
    (
      await rt.port.createContact({
        name: clientFullName(c),
        email: email || undefined,
        phone: c.phone ?? undefined,
      })
    ).contactId;
  await deps.db.update(client).set({ xeroContactId: contactId }).where(eq(client.id, c.id));
  return contactId;
}

interface InvoiceRef {
  invoiceId: string;
  /** Known only when we just created it. */
  invoiceNumber?: string;
}

async function ensureInvoice(ctx: Ctx, bundle: BookingBundle): Promise<InvoiceRef> {
  const { deps, rt, timezone } = ctx;
  if (bundle.booking.xeroInvoiceId) return { invoiceId: bundle.booking.xeroInvoiceId };

  const contactId = await ensureContact(ctx, bundle.client);
  const date = localDate(bundle.booking.during.start, timezone);
  const created = await rt.port.createInvoice({
    contactId,
    reference: bundle.booking.id,
    date,
    dueDate: date,
    lines: invoiceLines(bundle, rt.config),
    lineAmountTypes: amountTypesFor(rt.config),
    idempotencyKey: `booking-invoice-${bundle.booking.id}`,
  });
  await deps.db
    .update(booking)
    .set({ xeroInvoiceId: created.invoiceId })
    .where(eq(booking.id, bundle.booking.id));
  return { invoiceId: created.invoiceId, invoiceNumber: created.invoiceNumber };
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

async function applyPayment(
  { deps, rt, timezone }: Ctx,
  p: PaymentRow,
  invoiceId: string,
): Promise<void> {
  const created = await rt.port.createPayment({
    invoiceId,
    accountCode: accountCodeForMethod(p.method, rt.config),
    amountCents: p.amountCents,
    date: localDate(p.createdAt, timezone),
    reference: p.stripePaymentIntentId ?? p.id,
    idempotencyKey: `payment-${p.id}`,
  });
  await deps.db
    .update(payment)
    .set({ xeroPaymentId: created.paymentId })
    .where(eq(payment.id, p.id));
}

/** Deposit/balance payments that succeeded but are not in Xero yet. */
async function unpushedPayments(deps: XeroDeps, bookingId: string): Promise<PaymentRow[]> {
  return deps.db
    .select()
    .from(payment)
    .where(
      and(
        eq(payment.bookingId, bookingId),
        inArray(payment.kind, ["deposit", "balance"]),
        inArray(payment.status, [...SETTLED_STATUSES]),
        isNull(payment.xeroPaymentId),
      ),
    )
    .orderBy(payment.createdAt);
}

/**
 * A no-show / late-cancel fee is revenue of its own: it gets a small invoice, then the payment
 * that settled it.
 */
async function pushFeePayment(ctx: Ctx, bundle: BookingBundle, p: PaymentRow): Promise<void> {
  const { deps, rt, timezone } = ctx;
  const known = (p.metadata.xero as { invoiceId?: string } | undefined)?.invoiceId;
  let invoiceId = known;
  if (!invoiceId) {
    const contactId = await ensureContact(ctx, bundle.client);
    const date = localDate(p.createdAt, timezone);
    const label = p.kind === "no_show_fee" ? "No-show fee" : "Late cancellation fee";
    const created = await rt.port.createInvoice({
      contactId,
      reference: bundle.booking.id,
      date,
      dueDate: date,
      lines: [singleLine(label, p.amountCents, rt.config)],
      lineAmountTypes: amountTypesFor(rt.config),
      idempotencyKey: `fee-invoice-${p.id}`,
    });
    invoiceId = created.invoiceId;
    await deps.db
      .update(payment)
      .set({ metadata: { ...p.metadata, xero: { ...(p.metadata.xero as object), invoiceId } } })
      .where(eq(payment.id, p.id));
  }
  await applyPayment(ctx, p, invoiceId);
}

/* -------------------------------------------------------------------------- */
/* Invoice email                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the invoice PDF and hand it to notifications, once per booking. A failure to send is
 * logged and left claimed-but-unprocessed for the reconcile job; it never fails the push.
 */
export async function emailInvoiceOnce(
  ctx: Ctx,
  bookingId: string,
  invoice: InvoiceRef,
): Promise<void> {
  const { deps, rt } = ctx;
  if (!rt.config.emailInvoice) return;
  const key = emailClaimKey(bookingId);
  if (!(await claimOnce(deps.db, "xero", key))) return;

  const invoiceNumber =
    invoice.invoiceNumber || (await rt.port.getInvoice(invoice.invoiceId)).invoiceNumber;
  const pdf = await rt.port.getInvoicePdf(invoice.invoiceId);
  try {
    await (deps.sendInvoiceEmail ?? sendInvoiceEmail)(deps.db, { bookingId, invoiceNumber, pdf });
    await markProcessed(deps.db, "xero", key, deps.now());
  } catch (error) {
    deps.log({ event: "xero_invoice_email_failed", bookingId, message: errorMessage(error) });
    ctx.notes.push(`Invoice email failed: ${errorMessage(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Event handlers                                                             */
/* -------------------------------------------------------------------------- */

async function onBookingConfirmed(ctx: Ctx, bookingId: string): Promise<void> {
  const bundle = await loadBookingBundle(ctx.deps.db, bookingId);
  // Imported bookings were already invoiced in the old system; syncing them would double count.
  if (bundle && isImportedSource(bundle.booking.source)) return;
  if (!bundle || !LIVE_STATUSES.includes(bundle.booking.status)) {
    ctx.deps.log({ event: "xero_skipped", reason: "not_live", bookingId });
    return;
  }
  if (bundle.booking.totalCents <= 0) {
    ctx.deps.log({ event: "xero_skipped", reason: "zero_total", bookingId });
    return;
  }

  const invoice = await ensureInvoice(ctx, bundle);

  // Apply every payment, but still email the invoice if one of them is blocked by config.
  let firstError: unknown;
  for (const p of await unpushedPayments(ctx.deps, bookingId)) {
    try {
      await applyPayment(ctx, p, invoice.invoiceId);
    } catch (error) {
      firstError ??= error;
    }
  }
  await emailInvoiceOnce(ctx, bookingId, invoice);
  if (firstError) throw firstError;
}

async function onPaymentSucceeded(ctx: Ctx, paymentId: string): Promise<void> {
  const { deps } = ctx;
  const [p] = await deps.db.select().from(payment).where(eq(payment.id, paymentId));
  if (!p || !p.bookingId || p.xeroPaymentId || p.kind === "refund") return;
  if (!SETTLED_STATUSES.includes(p.status)) return;

  const bundle = await loadBookingBundle(deps.db, p.bookingId);
  // Imported bookings were already invoiced in the old system; syncing them would double count.
  if (bundle && isImportedSource(bundle.booking.source)) return;
  if (!bundle) return;

  if (p.kind === "no_show_fee" || p.kind === "late_cancel_fee") {
    await pushFeePayment(ctx, bundle, p);
    return;
  }
  if (!bundle.booking.xeroInvoiceId) {
    // No invoice yet: the confirmed path creates it and applies this payment with it. If the
    // booking is not confirmed yet, booking.confirmed will do the same later.
    if (LIVE_STATUSES.includes(bundle.booking.status)) await onBookingConfirmed(ctx, p.bookingId);
    return;
  }
  await applyPayment(ctx, p, bundle.booking.xeroInvoiceId);
}

/**
 * payment.refunded carries the id of the refund payment row (kind 'refund'); the original is
 * at metadata.refundOf. Books a credit note for the refunded amount and pays it back out of the
 * same account the original payment landed in.
 */
async function onPaymentRefunded(ctx: Ctx, refundId: string): Promise<void> {
  const { deps, rt, timezone } = ctx;
  const [refund] = await deps.db.select().from(payment).where(eq(payment.id, refundId));
  if (!refund || !refund.bookingId || refund.xeroPaymentId) return;
  if (refund.kind !== "refund") {
    deps.log({ event: "xero_skipped", reason: "not_a_refund_row", paymentId: refundId });
    return;
  }
  const bundle = await loadBookingBundle(deps.db, refund.bookingId);
  // Imported bookings were already invoiced in the old system; syncing them would double count.
  if (bundle && isImportedSource(bundle.booking.source)) return;
  if (!bundle?.booking.xeroInvoiceId) {
    deps.log({ event: "xero_skipped", reason: "no_invoice", paymentId: refundId });
    return;
  }

  const originalId = refund.metadata.refundOf;
  const [original] =
    typeof originalId === "string"
      ? await deps.db.select().from(payment).where(eq(payment.id, originalId))
      : [];
  // The money must be in Xero before it can be paid back out.
  if (original && !original.xeroPaymentId && original.kind !== "refund") {
    await applyPayment(ctx, original, bundle.booking.xeroInvoiceId);
  }
  const accountCode = accountCodeForMethod(original?.method ?? refund.method, rt.config);

  const progress = (refund.metadata.xero ?? {}) as { creditNoteId?: string };
  const date = localDate(refund.createdAt, timezone);
  let creditNoteId = progress.creditNoteId;
  if (!creditNoteId) {
    const contactId = await ensureContact(ctx, bundle.client);
    const created = await rt.port.createCreditNote({
      contactId,
      reference: bundle.booking.id,
      date,
      lines: [singleLine("Refund", refund.amountCents, rt.config)],
      lineAmountTypes: amountTypesFor(rt.config),
      idempotencyKey: `credit-${refund.id}`,
    });
    creditNoteId = created.creditNoteId;
    // Persist before the next call so a retry never raises a second credit note.
    await deps.db
      .update(payment)
      .set({ metadata: { ...refund.metadata, xero: { ...progress, creditNoteId } } })
      .where(eq(payment.id, refund.id));
  }

  const paid = await rt.port.refundCreditNote({
    creditNoteId,
    accountCode,
    amountCents: refund.amountCents,
    date,
    reference: refund.stripeRefundId ?? refund.id,
    idempotencyKey: `refund-${refund.id}`,
  });
  await deps.db
    .update(payment)
    .set({ xeroPaymentId: paid.paymentId })
    .where(eq(payment.id, refund.id));
}

/**
 * A cancelled or no-show booking will never pay its balance. Credit the unpaid part of the
 * invoice so revenue equals what was actually kept (a forfeited deposit stays as revenue).
 */
async function onBookingGone(ctx: Ctx, bookingId: string): Promise<void> {
  if (!ctx.rt.config.writeOffOnCancel) return;
  await creditUnpaidBalance(ctx, bookingId, "Cancelled booking: unpaid balance");
}

/**
 * A booking completed at checkout is settled by definition: whatever is still owed on the invoice is
 * the discount the owner gave (for example the cash discount), so credit it and allocate it.
 */
async function onBookingCompleted(ctx: Ctx, bookingId: string): Promise<void> {
  await creditUnpaidBalance(ctx, bookingId, "Discount at checkout");
}

async function creditUnpaidBalance(
  ctx: Ctx,
  bookingId: string,
  description: string,
): Promise<void> {
  const { deps, rt, timezone } = ctx;
  const bundle = await loadBookingBundle(deps.db, bookingId);
  // Imported bookings were already invoiced in the old system; syncing them would double count.
  if (bundle && isImportedSource(bundle.booking.source)) return;
  const invoiceId = bundle?.booking.xeroInvoiceId;
  if (!bundle || !invoiceId) return;

  const invoice = await rt.port.getInvoice(invoiceId);
  if (invoice.status !== "AUTHORISED" || invoice.amountDueCents <= 0) return;

  const contactId = await ensureContact(ctx, bundle.client);
  const date = localDate(deps.now(), timezone);
  const credit = await rt.port.createCreditNote({
    contactId,
    reference: bookingId,
    date,
    lines: [singleLine(description, invoice.amountDueCents, rt.config)],
    lineAmountTypes: amountTypesFor(rt.config),
    idempotencyKey: `writeoff-${bookingId}`,
  });
  await rt.port.allocateCreditNote({
    creditNoteId: credit.creditNoteId,
    invoiceId,
    amountCents: invoice.amountDueCents,
    date,
    idempotencyKey: `writeoff-alloc-${bookingId}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function dispatch(ctx: Ctx, event: IncomingXeroEvent): Promise<void> {
  switch (event.type) {
    case "booking.confirmed":
      if (event.bookingId) await onBookingConfirmed(ctx, event.bookingId);
      return;
    case "booking.cancelled":
    case "booking.no_show":
      if (event.bookingId) await onBookingGone(ctx, event.bookingId);
      return;
    case "booking.completed":
      if (event.bookingId) await onBookingCompleted(ctx, event.bookingId);
      return;
    case "payment.succeeded":
      if (event.paymentId) await onPaymentSucceeded(ctx, event.paymentId);
      return;
    case "payment.refunded":
      if (event.paymentId) await onPaymentRefunded(ctx, event.paymentId);
      return;
  }
}

/** Record a failure so the admin UI shows it; auth failures flip the account to 'error'. */
export async function reportXeroFailure(deps: XeroDeps, error: unknown): Promise<void> {
  const fatal = error instanceof AuthRevokedError;
  await recordFailure(deps.db, "xero", fatal ? XERO_RECONNECT_MESSAGE : errorMessage(error), {
    fatal,
  });
  deps.log({ event: "xero_failure", fatal, message: errorMessage(error) });
}

/** Success clears the previous error, unless something non-fatal still needs the owner's eye. */
async function settle(deps: XeroDeps, notes: string[]): Promise<void> {
  if (notes.length > 0) await recordFailure(deps.db, "xero", notes[0], { fatal: false });
  else await recordSuccess(deps.db, "xero", deps.now());
}

/**
 * Consumer for `consumer.xero`. Ignores other event types and is idempotent: every step checks
 * what already exists in Xero (via the ids stored on our rows) before creating anything.
 *
 * Failures never lose the event. Retryable ones (429, 5xx, network) are recorded on
 * integration_account.lastError and rethrown so the queue retries with backoff. Ones that need a
 * person (revoked access, missing account codes, rejected data) are recorded and not retried
 * here; the hourly reconcile job picks the work up again once they are fixed.
 */
export async function handleXeroDomainEvent(
  deps: XeroConsumerDeps,
  event: IncomingXeroEvent,
): Promise<void> {
  if (!HANDLED.has(event.type)) return;

  try {
    const rt = await loadXeroRuntime(deps);
    const { timezone } = await getBusiness(deps.db);
    const ctx: Ctx = { deps, rt, timezone, notes: [] };
    await dispatch(ctx, event);
    await settle(deps, ctx.notes);
  } catch (error) {
    if (error instanceof NotConnectedError) {
      deps.log({ event: "xero_skipped", reason: "not_connected", type: event.type });
      return;
    }
    await reportXeroFailure(deps, error);
    if (isRetryable(error)) throw error;
  }
}

/** Retry the invoice email for a booking whose earlier send failed (reconcile job). */
export async function retryInvoiceEmail(deps: XeroConsumerDeps, bookingId: string): Promise<void> {
  try {
    const rt = await loadXeroRuntime(deps);
    const { timezone } = await getBusiness(deps.db);
    const bundle = await loadBookingBundle(deps.db, bookingId);
    if (!bundle?.booking.xeroInvoiceId) return;
    const ctx: Ctx = { deps, rt, timezone, notes: [] };
    await emailInvoiceOnce(ctx, bookingId, { invoiceId: bundle.booking.xeroInvoiceId });
    await settle(deps, ctx.notes);
  } catch (error) {
    if (error instanceof NotConnectedError) return;
    await reportXeroFailure(deps, error);
  }
}

export { emailClaimKey };
