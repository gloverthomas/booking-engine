import * as Sentry from "@sentry/node";
import { PgBoss } from "pg-boss";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { sentryOptions } from "@/lib/sentry";
import { withJobErrorReporting } from "./error-reporting";
import { JOBS, handleHeartbeat } from "./jobs";
import type { RegisterHandlers, WorkerContext } from "./context";
import { register as registerRelay } from "./handlers/relay";
import { register as registerNotifications } from "./handlers/notifications";
import { register as registerGoogle } from "./handlers/google";
import { register as registerXero } from "./handlers/xero";
import { register as registerPayments } from "./handlers/payments";

const HANDLERS: RegisterHandlers[] = [
  registerRelay,
  registerPayments,
  registerNotifications,
  registerGoogle,
  registerXero,
];

async function main(): Promise<void> {
  const env = getEnv();
  const log = createLogger("worker");
  Sentry.init(
    sentryOptions({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT,
      release: process.env.RAILWAY_GIT_COMMIT_SHA,
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
    }),
  );
  const rawBoss = new PgBoss(env.DATABASE_URL);
  // Job handlers that throw are reported to Sentry, then retried by pg-boss as before.
  const boss = withJobErrorReporting(rawBoss, (error, queue) =>
    Sentry.captureException(error, { tags: { queue } }),
  );

  rawBoss.on("error", (error) => {
    log({ event: "boss_error", message: error.message });
    Sentry.captureException(error);
  });
  await boss.start();

  const ctx: WorkerContext = { boss, db: getDb(), log, now: () => new Date() };

  await boss.createQueue(JOBS.heartbeat);
  await boss.work(JOBS.heartbeat, async () => handleHeartbeat({ log, now: ctx.now }));
  await boss.schedule(JOBS.heartbeat, "*/15 * * * *");

  for (const register of HANDLERS) await register(ctx);

  log({ event: "worker_started" });

  const shutdown = async (signal: string): Promise<void> => {
    log({ event: "worker_stopping", signal });
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  Sentry.captureException(error);
  await Sentry.flush(2000);
  process.stderr.write(`${JSON.stringify({ service: "worker", event: "fatal", message })}\n`);
  process.exit(1);
});
