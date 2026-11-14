import {
  REMINDER_QUEUE,
  handleNotificationEvent,
  handleReminderJob,
  type EventHandlerContext,
} from "@/server/notifications/handle-event";
import { createDefaultDeps } from "@/server/notifications/providers";
import type { NotificationDeps } from "@/server/notifications/types";
import type { RegisterHandlers } from "../context";

export const NOTIFICATIONS_QUEUE = "consumer.notifications";

/**
 * `consumer.notifications` receives every domain event and acts on the booking ones.
 * `notifications.reminder` holds delayed jobs (one per booking start time). Both are retried by
 * pg-boss when a send fails transiently; message_log dedupe keeps retries from double sending.
 */
export const register: RegisterHandlers = async (ctx) => {
  const { boss, db, log } = ctx;
  const deps: NotificationDeps = createDefaultDeps({ log, now: ctx.now });
  const handlerContext: EventHandlerContext = {
    db,
    deps,
    scheduler: { send: (queue, data, options) => boss.send(queue, data, options) },
  };

  await boss.createQueue(NOTIFICATIONS_QUEUE);
  // `short` + singletonKey: at most one queued job per booking start time, so replays cannot stack reminders.
  await boss.createQueue(REMINDER_QUEUE, {
    policy: "short",
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
  });

  await boss.work(NOTIFICATIONS_QUEUE, async (jobs) => {
    for (const job of jobs) await handleNotificationEvent(handlerContext, job.data);
  });

  await boss.work(REMINDER_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const outcome = await handleReminderJob(handlerContext, job.data);
      log({ event: "reminder_processed", outcome });
    }
  });
};
