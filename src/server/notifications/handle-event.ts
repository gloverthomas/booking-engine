import { z } from "zod";
import type { Db } from "../db-types";
import { loadBookingContext } from "./booking-context";
import {
  notifyBookingCancelled,
  notifyFeeCharged,
  notifyBookingConfirmed,
  notifyBookingMoved,
  sendBookingReminder,
} from "./booking-notifications";
import { notifyStaffOfBooking, type StaffAlertEvent } from "./staff-alerts";
import type { LoggedSendResult } from "./message-log";
import type { NotificationDeps } from "./types";
import { notifyWaitlistOffer } from "./waitlist-notifications";

export const REMINDER_QUEUE = "notifications.reminder";

/** The slice of pg-boss we use; lets tests pass a fake. */
export interface JobScheduler {
  send(
    queue: string,
    data: object,
    options: { startAfter: Date; singletonKey: string },
  ): Promise<string | null>;
}

const reminderJobSchema = z.object({
  bookingId: z.uuid(),
  expectedStart: z.string().min(1),
});
export type ReminderJob = z.infer<typeof reminderJobSchema>;

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("booking.confirmed"),
    bookingId: z.uuid(),
    notifyClient: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("booking.rescheduled"),
    eventId: z.string().optional(),
    bookingId: z.uuid(),
    previousStart: z.string(),
    notifyClient: z.boolean(),
    /** Not in the shared event type today; used when a producer supplies it. */
    previousStaffId: z.uuid().optional(),
  }),
  z.object({ type: z.literal("booking.expired"), bookingId: z.uuid() }),
  z.object({ type: z.literal("waitlist.offer_created"), offerId: z.uuid() }),
  z.object({ type: z.literal("payment.succeeded"), paymentId: z.uuid() }),
  z.object({
    type: z.literal("booking.cancelled"),
    bookingId: z.uuid(),
    by: z.enum(["client", "staff"]),
    depositAction: z.enum(["refund", "keep", "none"]),
    feeCents: z.number(),
  }),
]);

export interface EventHandlerContext {
  db: Db;
  deps: NotificationDeps;
  scheduler: JobScheduler;
  /** Injected in tests; defaults to W6's notifyWaitlistOffer. */
  notifyWaitlistOffer?: typeof notifyWaitlistOffer;
}

/**
 * Run every step even when one throws, then rethrow the first failure so the queue retries the
 * event (every send is deduplicated, so the steps that worked do not repeat).
 */
async function settle(steps: Array<() => Promise<unknown>>): Promise<void> {
  let failure: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error: unknown) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

export type ReminderScheduleResult =
  "scheduled" | "skipped_past" | "skipped_not_confirmed" | "skipped_duplicate";

/**
 * Queue the reminder for `start - reminderHoursBefore`. Skipped when that moment has passed.
 * The singleton key makes scheduling idempotent, and the job re-validates the booking when it runs.
 */
export async function scheduleReminder(
  { db, deps, scheduler }: EventHandlerContext,
  bookingId: string,
): Promise<ReminderScheduleResult> {
  const ctx = await loadBookingContext(db, bookingId);
  if (!ctx || ctx.status !== "confirmed") return "skipped_not_confirmed";

  const sendAt = new Date(ctx.start.getTime() - ctx.settings.reminderHoursBefore * 3_600_000);
  if (sendAt.getTime() <= deps.now().getTime()) {
    deps.log({ event: "reminder_not_scheduled_past", bookingId, sendAt: sendAt.toISOString() });
    return "skipped_past";
  }
  const startIso = ctx.start.toISOString();
  const jobId = await scheduler.send(
    REMINDER_QUEUE,
    { bookingId, expectedStart: startIso } satisfies ReminderJob,
    { startAfter: sendAt, singletonKey: `reminder:${bookingId}:${startIso}` },
  );
  return jobId === null ? "skipped_duplicate" : "scheduled";
}

/**
 * Handles one domain event from `consumer.notifications`. Types we do not care about are ignored.
 * Safe to run twice for the same event: every send is deduplicated in message_log.
 */
export async function handleNotificationEvent(
  context: EventHandlerContext,
  rawEvent: unknown,
): Promise<void> {
  const parsed = eventSchema.safeParse(rawEvent);
  if (!parsed.success) return; // another module's event (or nothing we act on)
  const event = parsed.data;
  const { db, deps } = context;

  switch (event.type) {
    case "booking.confirmed":
      await settle([
        async () => {
          if (event.notifyClient === false) {
            await notifyBookingConfirmed(db, event.bookingId, deps, { skipClient: true });
            return;
          }
          await notifyBookingConfirmed(db, event.bookingId, deps);
          await scheduleReminder(context, event.bookingId);
        },
        () => alertStylist(context, event.bookingId, { type: "confirmed" }),
      ]);
      return;
    case "booking.rescheduled": {
      const previousStart = new Date(event.previousStart);
      if (Number.isNaN(previousStart.getTime())) {
        deps.log({ event: "reschedule_event_bad_previous_start", bookingId: event.bookingId });
        return;
      }
      await settle([
        async () => {
          await notifyBookingMoved(
            db,
            event.bookingId,
            { previousStart, notifyClient: event.notifyClient },
            deps,
          );
          await scheduleReminder(context, event.bookingId);
        },
        () =>
          alertStylist(context, event.bookingId, {
            type: "rescheduled",
            previousStart,
            eventKey: event.eventId ?? event.previousStart,
            previousStaffId: event.previousStaffId,
          }),
      ]);
      return;
    }
    case "payment.succeeded":
      await notifyFeeCharged(db, event.paymentId, deps);
      return;
    case "booking.cancelled":
      await settle([
        () =>
          notifyBookingCancelled(
            db,
            event.bookingId,
            { by: event.by, depositAction: event.depositAction, feeCents: event.feeCents },
            deps,
          ),
        () => alertStylist(context, event.bookingId, { type: "cancelled" }),
      ]);
      return;
    case "waitlist.offer_created":
      await (context.notifyWaitlistOffer ?? notifyWaitlistOffer)(db, event.offerId, deps);
      return;
    case "booking.expired":
      // An unpaid hold lapsed: nobody was told about it, so there is nothing to retract.
      return;
  }
}

function alertStylist(
  { db, deps }: EventHandlerContext,
  bookingId: string,
  event: StaffAlertEvent,
): Promise<LoggedSendResult[]> {
  return notifyStaffOfBooking(db, bookingId, event, deps);
}

/** Handles one `notifications.reminder` job. Malformed jobs are dropped (retrying cannot fix them). */
export async function handleReminderJob(
  { db, deps }: EventHandlerContext,
  rawData: unknown,
): Promise<"sent" | "skipped"> {
  const parsed = reminderJobSchema.safeParse(rawData);
  if (!parsed.success) {
    deps.log({ event: "reminder_job_invalid", issues: parsed.error.issues.length });
    return "skipped";
  }
  const expectedStart = new Date(parsed.data.expectedStart);
  if (Number.isNaN(expectedStart.getTime())) {
    deps.log({ event: "reminder_job_invalid_start", bookingId: parsed.data.bookingId });
    return "skipped";
  }
  return sendBookingReminder(db, parsed.data.bookingId, expectedStart, deps);
}
