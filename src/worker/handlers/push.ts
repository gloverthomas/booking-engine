import { getEnv } from "@/lib/env";
import { createExpoSender, handlePushEvent } from "@/server/push";
import type { RegisterHandlers } from "../context";

export const PUSH_QUEUE = "consumer.push";

/**
 * `consumer.push` receives every domain event and sends the ones staff care about to their phones
 * (new client booking, client cancellation). A failure to reach Expo throws so pg-boss retries the job.
 */
export const register: RegisterHandlers = async ({ boss, db, log }) => {
  const sender = createExpoSender({ accessToken: getEnv().EXPO_ACCESS_TOKEN });
  await boss.createQueue(PUSH_QUEUE);
  await boss.work<Record<string, unknown>>(PUSH_QUEUE, async (jobs) => {
    for (const job of jobs) await handlePushEvent({ db, sender, log }, job.data);
  });
};
