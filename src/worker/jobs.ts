import type { LogFn } from "@/lib/logger";

export const JOBS = {
  heartbeat: "system.heartbeat",
} as const;

export interface HeartbeatDeps {
  log: LogFn;
  now: () => Date;
}

/** Proves the worker is alive and the queue is draining. Real jobs follow the same shape. */
export async function handleHeartbeat({ log, now }: HeartbeatDeps): Promise<void> {
  log({ event: "heartbeat", at: now().toISOString() });
}
