import { PgBoss } from "pg-boss";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { JOBS, handleHeartbeat } from "./jobs";

async function main(): Promise<void> {
  const env = getEnv();
  const log = createLogger("worker");
  const boss = new PgBoss(env.DATABASE_URL);

  boss.on("error", (error) => log({ event: "boss_error", message: error.message }));
  await boss.start();

  await boss.createQueue(JOBS.heartbeat);
  await boss.work(JOBS.heartbeat, async () => handleHeartbeat({ log, now: () => new Date() }));
  await boss.schedule(JOBS.heartbeat, "*/15 * * * *");

  log({ event: "worker_started" });

  const shutdown = async (signal: string): Promise<void> => {
    log({ event: "worker_stopping", signal });
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${JSON.stringify({ service: "worker", event: "fatal", message })}\n`);
  process.exit(1);
});
