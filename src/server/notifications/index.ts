import { eq } from "drizzle-orm";
import { business, client } from "@/db/schema";
import { renderInvoiceEmail, renderOneOffMessage } from "@/emails";
import { recordAudit } from "../audit";
import type { Db } from "../db-types";
import { loadBookingContext } from "./booking-context";
import { notifyBookingConfirmed } from "./booking-notifications";
import { prepareSms, runAll } from "./deliver";
import { invoiceProps } from "./message-builders";
import { sendLogged, type LoggedSendResult } from "./message-log";
import { createDefaultDeps } from "./providers";
import { isE164 } from "./sms-text";
import { PermanentSendError, type NotificationDeps } from "./types";

/**
 * Public entry points for other modules (admin actions, MCP, the Xero handler). Everything else
 * is driven by domain events through src/worker/handlers/notifications.ts.
 * `deps` is optional and exists so tests can inject fake providers.
 */

/** Admins want to see why it failed, so permanent failures throw here (the worker just records them). */
function assertNoFailures(results: LoggedSendResult[]): void {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    throw new Error(failed.map((r) => (r.status === "failed" ? r.error : "")).join("; "));
  }
}

/** Admin action: send the confirmation email and SMS again. */
export async function resendConfirmation(
  db: Db,
  bookingId: string,
  deps: NotificationDeps = createDefaultDeps(),
): Promise<void> {
  const ctx = await loadBookingContext(db, bookingId);
  if (!ctx) throw new Error(`Booking not found: ${bookingId}`);
  if (ctx.status !== "confirmed") {
    throw new Error(`Only confirmed bookings can be re-sent (status is ${ctx.status})`);
  }
  const results = await notifyBookingConfirmed(db, bookingId, deps, {
    resendToken: String(deps.now().getTime()),
  });
  assertNoFailures(results);
  await recordAudit(db, {
    actor: "system",
    action: "notification.resend_confirmation",
    entityType: "booking",
    entityId: bookingId,
    data: { sent: results.length },
  });
}

/** Admin / MCP action: a one-off message to a client. */
export async function sendOneOffMessage(
  db: Db,
  input: { clientId: string; channel: "email" | "sms"; subject?: string; body: string },
  deps: NotificationDeps = createDefaultDeps(),
): Promise<void> {
  const [row] = await db
    .select({ client, businessName: business.name })
    .from(client)
    .leftJoin(business, eq(business.id, client.businessId))
    .where(eq(client.id, input.clientId));
  if (!row) throw new Error(`Client not found: ${input.clientId}`);
  const { client: recipient } = row;
  const body = input.body.trim();
  if (!body) throw new Error("Message body is empty");

  const result =
    input.channel === "email"
      ? await sendOneOffEmail(db, deps, recipient, row.businessName, input.subject, body)
      : await sendOneOffSms(db, deps, recipient, body);
  assertNoFailures([result]);

  await recordAudit(db, {
    actor: "system",
    action: "notification.one_off",
    entityType: "client",
    entityId: input.clientId,
    data: { channel: input.channel, length: body.length },
  });
}

type ClientRow = typeof client.$inferSelect;

async function sendOneOffEmail(
  db: Db,
  deps: NotificationDeps,
  recipient: ClientRow,
  businessName: string | null,
  subject: string | undefined,
  body: string,
): Promise<LoggedSendResult> {
  if (!recipient.email) throw new Error("This client has no email address");
  const name = businessName ?? "Your stylist";
  const [result] = await runAll([
    () =>
      sendLogged(
        db,
        {
          clientId: recipient.id,
          channel: "email",
          template: "one_off",
          toAddress: recipient.email as string,
          dedupeKey: null,
          send: async () => {
            const rendered = await renderOneOffMessage({
              businessName: name,
              subject: subject?.trim() || `A message from ${name}`,
              body,
            });
            return deps.email().send({
              to: [recipient.email as string],
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            });
          },
        },
        deps.log,
        deps.now,
      ),
  ]);
  return result;
}

async function sendOneOffSms(
  db: Db,
  deps: NotificationDeps,
  recipient: ClientRow,
  body: string,
): Promise<LoggedSendResult> {
  const phone = recipient.phone;
  if (!phone) throw new Error("This client has no mobile number");
  const [result] = await runAll([
    () =>
      sendLogged(
        db,
        {
          clientId: recipient.id,
          channel: "sms",
          template: "one_off",
          toAddress: phone,
          dedupeKey: null,
          send: async () => {
            if (!isE164(phone)) throw new PermanentSendError(`Phone number is not E.164: ${phone}`);
            return deps.sms().send({ to: phone, body: prepareSms(body, deps) });
          },
        },
        deps.log,
        deps.now,
      ),
  ]);
  return result;
}

/** Called by the Xero handler once the invoice exists: emails the invoice PDF to the client. */
export async function sendInvoiceEmail(
  db: Db,
  input: { bookingId: string; invoiceNumber: string; pdf: Uint8Array },
  deps: NotificationDeps = createDefaultDeps(),
): Promise<void> {
  const ctx = await loadBookingContext(db, input.bookingId);
  if (!ctx) throw new Error(`Booking not found: ${input.bookingId}`);
  const address = ctx.client.email;
  if (!address) {
    deps.log({ event: "invoice_email_skipped_no_email", bookingId: input.bookingId });
    return;
  }
  const safeNumber = input.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_");
  const [result] = await runAll([
    () =>
      sendLogged(
        db,
        {
          bookingId: ctx.bookingId,
          clientId: ctx.client.id,
          channel: "email",
          template: "invoice",
          toAddress: address,
          dedupeKey: `${ctx.bookingId}:invoice-${safeNumber}:email`,
          send: async () => {
            const rendered = await renderInvoiceEmail(invoiceProps(ctx, input.invoiceNumber));
            return deps.email().send({
              to: [address],
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              attachments: [
                {
                  filename: `Invoice-${safeNumber}.pdf`,
                  content: input.pdf,
                  contentType: "application/pdf",
                },
              ],
            });
          },
        },
        deps.log,
        deps.now,
      ),
  ]);
  assertNoFailures(result ? [result] : []);
}
