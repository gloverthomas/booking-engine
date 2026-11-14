import { relayDomainEvents, EVENT_CONSUMERS } from "@/server/events";
import type { RegisterHandlers } from "../context";

export const RELAY_QUEUE = "events.relay";

/** Moves outbox events to consumer queues every minute. */
export const register: RegisterHandlers = async ({ boss, db, log }) => {
  await boss.createQueue(RELAY_QUEUE);
  for (const queue of EVENT_CONSUMERS) await boss.createQueue(queue);

  await boss.work(RELAY_QUEUE, async () => {
    const count = await relayDomainEvents(db, async (queue, data) => {
      await boss.send(queue, data);
    });
    if (count > 0) log({ event: "events_relayed", count });
  });
  await boss.schedule(RELAY_QUEUE, "* * * * *");
};
