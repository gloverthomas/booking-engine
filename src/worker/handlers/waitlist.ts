import { expireWaitlist, handleWaitlistEvent } from "@/server/waitlist";
import type { RegisterHandlers } from "../context";

export const WAITLIST_QUEUE = "consumer.waitlist";
export const EXPIRE_WAITLIST_QUEUE = "waitlist.expire";

/**
 * `consumer.waitlist` receives every domain event: freed slots are offered to the waitlist and
 * confirmed bookings close their matching entries and competing offers. `waitlist.expire` runs hourly
 * to expire lapsed offers and entries. Both are idempotent, so pg-boss retries are safe.
 */
export const register: RegisterHandlers = async ({ boss, db, log, now }) => {
  await boss.createQueue(WAITLIST_QUEUE);
  await boss.work<Record<string, unknown>>(WAITLIST_QUEUE, async (jobs) => {
    for (const job of jobs) await handleWaitlistEvent({ db, log, now }, job.data);
  });

  await boss.createQueue(EXPIRE_WAITLIST_QUEUE);
  await boss.work(EXPIRE_WAITLIST_QUEUE, async () => {
    const changed = await expireWaitlist(db, now());
    if (changed > 0) log({ event: "waitlist_expired", count: changed });
  });
  await boss.schedule(EXPIRE_WAITLIST_QUEUE, "0 * * * *");
};
