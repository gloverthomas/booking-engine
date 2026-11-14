import type { PgBoss } from "pg-boss";

/**
 * Failed pushes are retried with exponential backoff (30s, 1m, 2m, ... capped at 1h) for about
 * a day before the job is given up on. The hourly reconcile job is the backstop after that.
 */
export const CONSUMER_RETRY = {
  retryLimit: 10,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 3600,
} as const;

/**
 * Subscribe to a consumer queue one event at a time. Serial processing keeps Xero calls ordered
 * (invoice before payment) and well inside its rate limits.
 */
export async function registerConsumer<T extends object>(
  boss: PgBoss,
  queue: string,
  handle: (data: T) => Promise<void>,
): Promise<void> {
  await boss.createQueue(queue, CONSUMER_RETRY);
  await boss.updateQueue(queue, CONSUMER_RETRY);
  await boss.work<T>(queue, { localConcurrency: 1, batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handle(job.data);
  });
}

/** A recurring job: its own queue, a cron schedule and a handler. */
export async function registerScheduledJob(
  boss: PgBoss,
  name: string,
  cron: string,
  run: () => Promise<void>,
): Promise<void> {
  await boss.createQueue(name);
  await boss.work(name, async () => {
    await run();
  });
  await boss.schedule(name, cron);
}
