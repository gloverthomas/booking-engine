import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWorld, type World } from "../availability/setup";
import { join, NOW, offerTo } from "./setup";
import { EXPIRE_WAITLIST_QUEUE, WAITLIST_QUEUE, register } from "@/worker/handlers/waitlist";
import type { WorkerContext } from "@/worker/context";
import { waitlistEntry } from "@/db/schema";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

type Handler = (jobs: Array<{ data: Record<string, unknown> }>) => Promise<void>;

function fakeBoss() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async (queue: string, handler: Handler) => {
      handlers.set(queue, handler);
    }),
    schedule: vi.fn(async () => {}),
  };
}

describe("waitlist worker", () => {
  test("registers the consumer and an hourly expiry job", async () => {
    const boss = fakeBoss();
    const log = vi.fn();
    const later = new Date(NOW.getTime() + 25 * 60_000);
    await register({
      boss: boss as unknown as WorkerContext["boss"],
      db: w.db,
      log,
      now: () => later,
    });

    expect(boss.createQueue).toHaveBeenCalledWith(WAITLIST_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith(EXPIRE_WAITLIST_QUEUE);
    expect(boss.schedule).toHaveBeenCalledWith(EXPIRE_WAITLIST_QUEUE, "0 * * * *");

    // Unrelated events pass through harmlessly.
    await boss.handlers.get(WAITLIST_QUEUE)?.([{ data: { type: "client.updated" } }]);

    const { entryId } = await join(w);
    await offerTo(w, entryId);
    await boss.handlers.get(EXPIRE_WAITLIST_QUEUE)?.([]);
    expect(log).toHaveBeenCalledWith({ event: "waitlist_expired", count: 2 });
    const [row] = await w.db.select().from(waitlistEntry);
    expect(row.status).toBe("waiting");

    log.mockClear();
    await boss.handlers.get(EXPIRE_WAITLIST_QUEUE)?.([]);
    expect(log).not.toHaveBeenCalled();
  });
});
