import { and, asc, eq, like } from "drizzle-orm";
import { messageLog, staff } from "@/db/schema";
import { renderStaffAlert, type StaffAlertKind } from "@/emails";
import type { Db } from "../db-types";
import { loadBookingContext, type BookingContext } from "./booking-context";
import { prepareSms, runAll, type Task } from "./deliver";
import { longDate, longTime } from "./format";
import { sendLogged, type LoggedSendResult } from "./message-log";
import { staffAlertSms, staffAlertWhen, staffServiceNames } from "./staff-alert-text";
import { isE164 } from "./sms-text";
import { PermanentSendError, type NotificationDeps, type SmsProvider } from "./types";

/** What happened to the booking, from the stylist's point of view. */
export type StaffAlertEvent =
  | { type: "confirmed" }
  | { type: "cancelled" }
  | {
      type: "rescheduled";
      previousStart: Date;
      /** Distinguishes one reassignment from the next; the relay's event id when there is one. */
      eventKey: string;
      /** When the event itself says who had the booking before. */
      previousStaffId?: string;
    };

interface Recipient {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

const TEMPLATE_PREFIX = "staff_alert_";
const HOLDING: ReadonlySet<StaffAlertKind> = new Set(["new", "moved", "assigned"]);

/**
 * Dedupe key `<booking>:staffalert:<kind>:<staff>:<suffix>:<channel>`. The staff id sits at a
 * fixed position so the history below can be read back without a staff column on message_log.
 */
function dedupeKey(
  bookingId: string,
  kind: StaffAlertKind,
  staffId: string,
  suffix: string,
  channel: "email" | "sms",
): string {
  return `${bookingId}:staffalert:${kind}:${staffId}:${suffix}:${channel}`;
}

interface PastAlert {
  kind: StaffAlertKind;
  staffId: string;
  suffix: string;
}

/** Every staff alert already logged for this booking, oldest first (email and SMS folded together). */
async function pastAlerts(db: Db, bookingId: string): Promise<PastAlert[]> {
  const rows = await db
    .select({ key: messageLog.dedupeKey })
    .from(messageLog)
    .where(
      and(eq(messageLog.bookingId, bookingId), like(messageLog.template, `${TEMPLATE_PREFIX}%`)),
    )
    .orderBy(asc(messageLog.createdAt));
  const alerts: PastAlert[] = [];
  for (const { key } of rows) {
    const parts = (key ?? "").split(":");
    // <booking>:staffalert:<kind>:<staff>:<suffix...>:<channel>
    if (parts[1] !== "staffalert" || parts.length < 6) continue;
    alerts.push({
      kind: parts[2] as StaffAlertKind,
      staffId: parts[3],
      suffix: parts.slice(4, -1).join(":"),
    });
  }
  return alerts;
}

/**
 * Who held the booking before this reassignment: stylists whose latest alert for it says they
 * still hold it, plus anyone already told "moved away" for this very event (so a replay
 * still recognises the event as a reassignment). The current stylist is never included.
 */
function previousHolders(history: PastAlert[], currentStaffId: string, eventKey: string): string[] {
  const latest = new Map<string, StaffAlertKind>();
  for (const alert of history) latest.set(alert.staffId, alert.kind);
  const holders = new Set<string>();
  for (const [staffId, kind] of latest) if (HOLDING.has(kind)) holders.add(staffId);
  for (const alert of history) {
    if (alert.kind === "moved_away" && alert.suffix === eventKey) holders.add(alert.staffId);
  }
  holders.delete(currentStaffId);
  return [...holders];
}

async function loadRecipient(db: Db, staffId: string): Promise<Recipient | null> {
  const [row] = await db
    .select({ id: staff.id, name: staff.name, email: staff.email, phone: staff.phone })
    .from(staff)
    .where(eq(staff.id, staffId));
  return row ?? null;
}

/** The SMS provider, or null (and a log line) when none is configured: SMS is then skipped quietly. */
function smsProviderOrNull(deps: NotificationDeps): SmsProvider | null {
  try {
    return deps.sms();
  } catch (error: unknown) {
    deps.log({
      event: "staff_alert_sms_skipped_no_provider",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface AlertInput {
  db: Db;
  deps: NotificationDeps;
  ctx: BookingContext;
  recipient: Recipient;
  kind: StaffAlertKind;
  suffix: string;
  /** The moment to describe: the appointment time, or the slot that was lost. */
  at: Date;
  previousStart?: Date;
  sms: SmsProvider | null;
}

function alertTasks(input: AlertInput): Task[] {
  const { db, deps, ctx, recipient, kind, suffix, at, sms } = input;
  const base = { bookingId: ctx.bookingId, template: `${TEMPLATE_PREFIX}${kind}` };
  const tasks: Task[] = [];

  const ownerEmails = deps.config().ownerEmails.map((e) => e.toLowerCase());
  const email = recipient.email?.trim() ?? "";
  if (email) {
    if (ownerEmails.includes(email.toLowerCase())) {
      // The owner alert already emails this address; a second message would be a duplicate.
      deps.log({ event: "staff_alert_email_skipped_owner", bookingId: ctx.bookingId, kind });
    } else {
      tasks.push(() =>
        sendLogged(
          db,
          {
            ...base,
            clientId: null,
            channel: "email",
            toAddress: email,
            dedupeKey: dedupeKey(ctx.bookingId, kind, recipient.id, suffix, "email"),
            send: async () => {
              const rendered = await renderStaffAlert({
                businessName: ctx.businessName,
                kind,
                staffFirstName: recipient.name.split(" ")[0] ?? recipient.name,
                clientFirstName: ctx.client.firstName,
                ...staffAlertWhen(ctx, at),
                previousWhen: input.previousStart
                  ? `${longDate(input.previousStart, ctx.timezone)}, ${longTime(input.previousStart, ctx.timezone)}`
                  : null,
                services: staffServiceNames(ctx),
                locationName: ctx.location.name,
              });
              return deps.email().send({
                to: [email],
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
              });
            },
          },
          deps.log,
          deps.now,
        ),
      );
    }
  }

  const phone = recipient.phone?.trim() ?? "";
  if (phone && sms) {
    tasks.push(() =>
      sendLogged(
        db,
        {
          ...base,
          clientId: null,
          channel: "sms",
          toAddress: phone,
          dedupeKey: dedupeKey(ctx.bookingId, kind, recipient.id, suffix, "sms"),
          send: async () => {
            if (!isE164(phone)) throw new PermanentSendError("Staff phone is not E.164");
            return sms.send({ to: phone, body: prepareSms(staffAlertSms(ctx, kind, at), deps) });
          },
        },
        deps.log,
        deps.now,
      ),
    );
  }
  return tasks;
}

/**
 * Tell the booking's stylist (email, and SMS when they have a phone and a provider is set up)
 * when a booking is made, moved or cancelled. On a stylist change the new stylist hears
 * "assigned to you" and the previous one "moved away". Contains no client phone or email.
 * Controlled by `settings.staffAlertsEnabled`; idempotent through message_log dedupe keys.
 */
export async function notifyStaffOfBooking(
  db: Db,
  bookingId: string,
  event: StaffAlertEvent,
  deps: NotificationDeps,
): Promise<LoggedSendResult[]> {
  const ctx = await loadBookingContext(db, bookingId);
  if (!ctx || !ctx.settings.staffAlertsEnabled) return [];
  if (event.type !== "cancelled" && ctx.status !== "confirmed") return [];

  const current = await loadRecipient(db, ctx.staffId);
  if (!current) return [];
  const sms = smsProviderOrNull(deps);
  const common = { db, deps, ctx, sms };
  const tasks: Task[] = [];

  if (event.type === "confirmed") {
    tasks.push(
      ...alertTasks({ ...common, recipient: current, kind: "new", suffix: "-", at: ctx.start }),
    );
  } else if (event.type === "cancelled") {
    tasks.push(
      ...alertTasks({
        ...common,
        recipient: current,
        kind: "cancelled",
        suffix: "-",
        at: ctx.start,
      }),
    );
  } else {
    const history = await pastAlerts(db, bookingId);
    const away = previousHolders(history, current.id, event.eventKey);
    if (event.previousStaffId && event.previousStaffId !== current.id) {
      if (!away.includes(event.previousStaffId)) away.push(event.previousStaffId);
    }
    if (away.length === 0) {
      tasks.push(
        ...alertTasks({
          ...common,
          recipient: current,
          kind: "moved",
          suffix: ctx.start.toISOString(),
          at: ctx.start,
          previousStart: event.previousStart,
        }),
      );
    } else {
      tasks.push(
        ...alertTasks({
          ...common,
          recipient: current,
          kind: "assigned",
          suffix: event.eventKey,
          at: ctx.start,
        }),
      );
      for (const staffId of away) {
        const previous = await loadRecipient(db, staffId);
        if (!previous) continue;
        tasks.push(
          ...alertTasks({
            ...common,
            recipient: previous,
            kind: "moved_away",
            suffix: event.eventKey,
            // The slot they lost is the one they had, not the new time.
            at: event.previousStart,
          }),
        );
      }
    }
  }
  return runAll(tasks);
}
