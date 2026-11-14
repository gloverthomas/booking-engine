import type { RenderedEmail } from "@/emails";
import { makeManageToken } from "../manage-token";
import type { Db } from "../db-types";
import type { BookingContext } from "./booking-context";
import { sendLogged, type LoggedSendResult } from "./message-log";
import { isE164, measureSms, toAsciiSafe } from "./sms-text";
import { PermanentSendError, type EmailAttachment, type NotificationDeps } from "./types";

/** A unit of delivery. Returns null when there is nothing to do (no address, no owner configured). */
export type Task = () => Promise<LoggedSendResult | null>;

/** Run every task even if one throws, then fail once with everything that went wrong so the queue retries. */
export async function runAll(tasks: Task[]): Promise<LoggedSendResult[]> {
  const results: LoggedSendResult[] = [];
  const errors: string[] = [];
  for (const task of tasks) {
    try {
      const result = await task();
      if (result) results.push(result);
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(`Notification delivery failed: ${errors.join("; ")}`);
  return results;
}

export function manageUrlFor(deps: NotificationDeps, bookingId: string): string {
  const { appUrl, encryptionKey } = deps.config();
  return `${appUrl}/manage/${makeManageToken(bookingId, encryptionKey)}`;
}

export function rebookUrlFor(deps: NotificationDeps): string {
  return `${deps.config().appUrl}/book`;
}

/** ASCII-safe, and warns when the text spills into extra (billed) segments. */
export function prepareSms(body: string, deps: NotificationDeps): string {
  const text = toAsciiSafe(body);
  const size = measureSms(text);
  if (size.segments > 1) {
    deps.log({ event: "sms_multi_segment", length: size.length, segments: size.segments });
  }
  return text;
}

interface ClientTaskBase {
  db: Db;
  deps: NotificationDeps;
  ctx: BookingContext;
  template: string;
  /** Becomes `<bookingId>:<dedupeBase>:<channel>`. */
  dedupeBase: string;
}

export function clientSmsTask(base: ClientTaskBase & { body: () => string }): Task {
  const { db, deps, ctx } = base;
  return async () => {
    const phone = ctx.client.phone;
    if (!phone) {
      deps.log({
        event: "sms_skipped_no_phone",
        bookingId: ctx.bookingId,
        template: base.template,
      });
      return null;
    }
    return sendLogged(
      db,
      {
        bookingId: ctx.bookingId,
        clientId: ctx.client.id,
        channel: "sms",
        template: base.template,
        toAddress: phone,
        dedupeKey: `${ctx.bookingId}:${base.dedupeBase}:sms`,
        send: async () => {
          if (!isE164(phone)) throw new PermanentSendError(`Phone number is not E.164: ${phone}`);
          return deps.sms().send({ to: phone, body: prepareSms(base.body(), deps) });
        },
      },
      deps.log,
      deps.now,
    );
  };
}

export interface BuiltEmail {
  rendered: RenderedEmail;
  attachments?: EmailAttachment[];
}

export function clientEmailTask(base: ClientTaskBase & { build: () => Promise<BuiltEmail> }): Task {
  const { db, deps, ctx } = base;
  return async () => {
    const address = ctx.client.email;
    if (!address) {
      deps.log({
        event: "email_skipped_no_email",
        bookingId: ctx.bookingId,
        template: base.template,
      });
      return null;
    }
    return sendLogged(
      db,
      {
        bookingId: ctx.bookingId,
        clientId: ctx.client.id,
        channel: "email",
        template: base.template,
        toAddress: address,
        dedupeKey: `${ctx.bookingId}:${base.dedupeBase}:email`,
        send: async () => {
          const { rendered, attachments } = await base.build();
          return deps.email().send({
            to: [address],
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            attachments,
          });
        },
      },
      deps.log,
      deps.now,
    );
  };
}

/** Email to the owner(s) listed in OWNER_EMAILS. Skipped when nobody is configured. */
export function ownerEmailTask(
  base: ClientTaskBase & { build: () => Promise<RenderedEmail> },
): Task {
  const { db, deps, ctx } = base;
  return async () => {
    const recipients = deps.config().ownerEmails;
    if (recipients.length === 0) {
      deps.log({ event: "owner_alert_skipped_no_owner_email", bookingId: ctx.bookingId });
      return null;
    }
    return sendLogged(
      db,
      {
        bookingId: ctx.bookingId,
        clientId: ctx.client.id,
        channel: "email",
        template: base.template,
        toAddress: recipients.join(", "),
        dedupeKey: `${ctx.bookingId}:${base.dedupeBase}:email`,
        send: async () => {
          const rendered = await base.build();
          return deps.email().send({
            to: recipients,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          });
        },
      },
      deps.log,
      deps.now,
    );
  };
}
