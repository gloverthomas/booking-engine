import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import type { WorkerContext } from "@/worker/context";
import type { NotificationDeps } from "@/server/notifications/types";
import { START, createBooking, createHarness, type Harness } from "./helpers";

const holder = vi.hoisted(() => ({ deps: undefined as NotificationDeps | undefined }));

vi.mock("@/server/notifications/providers", () => ({
  createDefaultDeps: () => {
    if (!holder.deps) throw new Error("test deps not set");
    return holder.deps;
  },
}));

import { NOTIFICATIONS_QUEUE, register } from "@/worker/handlers/notifications";

type Handler = (jobs: Array<{ data: unknown }>) => Promise<void>;

let h: Harness;
let handlers: Map<string, Handler>;
let sent: Array<{ queue: string; data: unknown; options: unknown }>;
let createQueue: ReturnType<typeof vi.fn>;
let ctx: WorkerContext;

beforeEach(async () => {
  h = await createHarness();
  holder.deps = h.deps;
  handlers = new Map();
  sent = [];
  createQueue = vi.fn(async () => {});
  const boss = {
    createQueue,
    work: vi.fn(async (queue: string, handler: Handler) => {
      handlers.set(queue, handler);
      return "worker-id";
    }),
    send: vi.fn(async (queue: string, data: unknown, options: unknown) => {
      sent.push({ queue, data, options });
      return "job-id";
    }),
  } as unknown as PgBoss;
  ctx = { boss, db: h.db, log: h.deps.log, now: h.deps.now };
});
afterEach(async () => {
  await h.close();
});

describe("notifications worker handler", () => {
  test("creates the reminder queue as `short` with retries and registers both workers", async () => {
    await register(ctx);
    expect(createQueue).toHaveBeenCalledWith(NOTIFICATIONS_QUEUE);
    expect(createQueue).toHaveBeenCalledWith(
      "notifications.reminder",
      expect.objectContaining({ policy: "short", retryLimit: 5 }),
    );
    expect([...handlers.keys()].sort()).toEqual([
      "consumer.notifications",
      "notifications.reminder",
    ]);
  });

  test("booking.confirmed from the relay sends messages and queues a delayed reminder", async () => {
    await register(ctx);
    const id = await createBooking(h);
    await handlers.get("consumer.notifications")?.([
      { data: { eventId: "e1", type: "booking.confirmed", bookingId: id } },
    ]);
    expect(h.sms.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe("notifications.reminder");
    expect(sent[0].options).toEqual({
      startAfter: new Date(START.getTime() - 24 * 3_600_000),
      singletonKey: `reminder:${id}:${START.toISOString()}`,
    });
  });

  test("other event types are ignored", async () => {
    await register(ctx);
    await handlers.get("consumer.notifications")?.([
      { data: { eventId: "e2", type: "payment.succeeded", paymentId: "p" } },
    ]);
    expect(h.sms.sent).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("a due reminder job sends the SMS and logs the outcome", async () => {
    await register(ctx);
    const id = await createBooking(h);
    h.setNow(new Date(START.getTime() - 24 * 3_600_000));
    await handlers.get("notifications.reminder")?.([
      { data: { bookingId: id, expectedStart: START.toISOString() } },
    ]);
    expect(h.sms.sent[0].body).toContain("friendly reminder");
    expect(h.logs).toContainEqual({ event: "reminder_processed", outcome: "sent" });
  });

  test("a transient provider failure propagates so pg-boss retries the job", async () => {
    await register(ctx);
    const id = await createBooking(h);
    holder.deps = {
      ...h.deps,
      sms: () => ({
        send: async () => {
          throw new Error("503");
        },
      }),
    };
    await register(ctx);
    h.setNow(new Date(START.getTime() - 24 * 3_600_000));
    await expect(
      handlers.get("notifications.reminder")?.([
        { data: { bookingId: id, expectedStart: START.toISOString() } },
      ]),
    ).rejects.toThrow(/503/);
  });
});
