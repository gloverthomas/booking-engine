import {
  renderBookingCancelled,
  renderBookingConfirmation,
  renderBookingMoved,
  renderOwnerAlert,
} from "@/emails";
import type { Db } from "../db-types";
import { loadBookingContext, type BookingContext } from "./booking-context";
import {
  clientEmailTask,
  clientSmsTask,
  manageUrlFor,
  ownerEmailTask,
  rebookUrlFor,
  runAll,
  type BuiltEmail,
  type Task,
} from "./deliver";
import { buildIcs } from "./ics";
import {
  cancelledProps,
  confirmationProps,
  movedProps,
  ownerAlertProps,
  type CancellationDetails,
} from "./message-builders";
import { smsCancelled, smsConfirmation, smsMoved, smsReminder } from "./sms-templates";
import type { LoggedSendResult } from "./message-log";
import type { NotificationDeps } from "./types";

const encoder = new TextEncoder();

function icsAttachment(ctx: BookingContext, manageUrl: string, sequence: number) {
  return {
    filename: "appointment.ics",
    content: encoder.encode(buildIcs(ctx, { manageUrl, sequence })),
    contentType: "text/calendar; charset=utf-8; method=PUBLISH",
  };
}

/** Load the booking, or log and return null when it no longer exists. */
async function load(db: Db, deps: NotificationDeps, bookingId: string, why: string) {
  const ctx = await loadBookingContext(db, bookingId);
  if (!ctx) deps.log({ event: "notification_skipped_booking_missing", bookingId, why });
  return ctx;
}

export interface ConfirmationOptions {
  /** Admin "resend": a fresh dedupe key so it really sends again, and no owner alert. */
  resendToken?: string;
}

/** Confirmation email (+ .ics) and SMS to the client, and an alert to the owner. */
export async function notifyBookingConfirmed(
  db: Db,
  bookingId: string,
  deps: NotificationDeps,
  options: ConfirmationOptions = {},
): Promise<LoggedSendResult[]> {
  const ctx = await load(db, deps, bookingId, "confirmed");
  if (!ctx) return [];
  if (ctx.status !== "confirmed") {
    deps.log({ event: "confirmation_skipped_not_confirmed", bookingId, status: ctx.status });
    return [];
  }
  const suffix = options.resendToken ? `@resend-${options.resendToken}` : "";
  const dedupeBase = `confirmation${suffix}`;

  const tasks: Task[] = [
    clientEmailTask({
      db,
      deps,
      ctx,
      template: "confirmation",
      dedupeBase,
      build: async (): Promise<BuiltEmail> => {
        const manageUrl = manageUrlFor(deps, bookingId);
        return {
          rendered: await renderBookingConfirmation(confirmationProps(ctx, manageUrl, true)),
          attachments: [icsAttachment(ctx, manageUrl, 0)],
        };
      },
    }),
    clientSmsTask({
      db,
      deps,
      ctx,
      template: "confirmation",
      dedupeBase,
      body: () => smsConfirmation({ ctx, manageUrl: manageUrlFor(deps, bookingId) }),
    }),
  ];
  if (!options.resendToken) {
    tasks.push(
      ownerEmailTask({
        db,
        deps,
        ctx,
        template: "owner_alert",
        dedupeBase: "owner-new",
        build: () => renderOwnerAlert(ownerAlertProps(ctx, "new")),
      }),
    );
  }
  return runAll(tasks);
}

/** "Your appointment moved" to the client (when asked) and an alert to the owner. */
export async function notifyBookingMoved(
  db: Db,
  bookingId: string,
  input: { previousStart: Date; notifyClient: boolean },
  deps: NotificationDeps,
): Promise<LoggedSendResult[]> {
  const ctx = await load(db, deps, bookingId, "moved");
  if (!ctx) return [];
  if (ctx.status !== "confirmed") {
    deps.log({ event: "moved_skipped_not_confirmed", bookingId, status: ctx.status });
    return [];
  }
  // Keyed by the new start so a second move sends again, while a replay of the same move does not.
  const dedupeBase = `moved@${ctx.start.toISOString()}`;
  const sequence = Math.floor(deps.now().getTime() / 1000);

  const tasks: Task[] = [];
  if (input.notifyClient) {
    tasks.push(
      clientEmailTask({
        db,
        deps,
        ctx,
        template: "moved",
        dedupeBase,
        build: async () => {
          const manageUrl = manageUrlFor(deps, bookingId);
          return {
            rendered: await renderBookingMoved(
              movedProps(ctx, input.previousStart, manageUrl, true),
            ),
            attachments: [icsAttachment(ctx, manageUrl, sequence)],
          };
        },
      }),
      clientSmsTask({
        db,
        deps,
        ctx,
        template: "moved",
        dedupeBase,
        body: () => smsMoved({ ctx, manageUrl: manageUrlFor(deps, bookingId) }),
      }),
    );
  }
  tasks.push(
    ownerEmailTask({
      db,
      deps,
      ctx,
      template: "owner_alert",
      dedupeBase: `owner-${dedupeBase}`,
      build: () =>
        renderOwnerAlert(
          ownerAlertProps(ctx, "rescheduled", { previousStart: input.previousStart }),
        ),
    }),
  );
  return runAll(tasks);
}

/** Cancellation to the client (stating what happens to the deposit) and an alert to the owner. */
export async function notifyBookingCancelled(
  db: Db,
  bookingId: string,
  details: CancellationDetails,
  deps: NotificationDeps,
): Promise<LoggedSendResult[]> {
  const ctx = await load(db, deps, bookingId, "cancelled");
  if (!ctx) return [];

  return runAll([
    clientEmailTask({
      db,
      deps,
      ctx,
      template: "cancelled",
      dedupeBase: "cancelled",
      build: async () => ({
        rendered: await renderBookingCancelled(cancelledProps(ctx, details, rebookUrlFor(deps))),
      }),
    }),
    clientSmsTask({
      db,
      deps,
      ctx,
      template: "cancelled",
      dedupeBase: "cancelled",
      body: () => smsCancelled(ctx, details.depositAction, rebookUrlFor(deps)),
    }),
    ownerEmailTask({
      db,
      deps,
      ctx,
      template: "owner_alert",
      dedupeBase: "owner-cancelled",
      build: () =>
        renderOwnerAlert(
          ownerAlertProps(ctx, "cancelled", { depositAction: details.depositAction }),
        ),
    }),
  ]);
}

export type ReminderOutcome = "sent" | "skipped";

/**
 * Sends the day-before reminder SMS, but only when the booking is still confirmed, still starts at
 * the time the job was scheduled for, and is still in the future. That check is what makes
 * reschedules and cancellations safe without ever cancelling queued jobs.
 */
export async function sendBookingReminder(
  db: Db,
  bookingId: string,
  expectedStart: Date,
  deps: NotificationDeps,
): Promise<ReminderOutcome> {
  const ctx = await load(db, deps, bookingId, "reminder");
  if (!ctx) return "skipped";
  const stale =
    ctx.status !== "confirmed" ||
    ctx.start.getTime() !== expectedStart.getTime() ||
    ctx.start.getTime() <= deps.now().getTime();
  if (stale) {
    deps.log({
      event: "reminder_skipped_stale",
      bookingId,
      status: ctx.status,
      expectedStart: expectedStart.toISOString(),
      start: ctx.start.toISOString(),
    });
    return "skipped";
  }

  const results = await runAll([
    clientSmsTask({
      db,
      deps,
      ctx,
      template: "reminder",
      dedupeBase: `reminder@${ctx.start.toISOString()}`,
      body: () => smsReminder({ ctx, manageUrl: manageUrlFor(deps, bookingId) }),
    }),
  ]);
  return results.some((r) => r.status === "sent") ? "sent" : "skipped";
}
