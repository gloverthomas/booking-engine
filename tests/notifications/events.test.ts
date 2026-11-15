import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { booking, business, messageLog, payment } from "@/db/schema";
import {
  REMINDER_QUEUE,
  handleNotificationEvent,
  handleReminderJob,
  scheduleReminder,
  type EventHandlerContext,
  type JobScheduler,
} from "@/server/notifications/handle-event";
import { START, createBooking, createHarness, type Harness } from "./helpers";

interface ScheduledJob {
  queue: string;
  data: { bookingId: string; expectedStart: string };
  startAfter: Date;
  singletonKey: string;
}

let h: Harness;
let jobs: ScheduledJob[];
let ctx: EventHandlerContext;

/** Behaves like a pg-boss `short` queue: a second job with the same singleton key is dropped. */
function fakeScheduler(): JobScheduler {
  return {
    async send(queue, data, options) {
      if (jobs.some((j) => j.singletonKey === options.singletonKey)) return null;
      jobs.push({ queue, data: data as ScheduledJob["data"], ...options });
      return `job-${jobs.length}`;
    },
  };
}

beforeEach(async () => {
  h = await createHarness();
  jobs = [];
  ctx = { db: h.db, deps: h.deps, scheduler: fakeScheduler() };
});
afterEach(async () => {
  await h.close();
});

describe("payment.succeeded (fee charged)", () => {
  async function feePayment(
    bookingId: string,
    over: Partial<typeof payment.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await h.db
      .insert(payment)
      .values({
        bookingId,
        kind: "no_show_fee",
        method: "stripe_online",
        status: "succeeded",
        amountCents: 2500,
        ...over,
      })
      .returning();
    return row.id;
  }

  test("emails the client once when a no-show fee is charged", async () => {
    const id = await createBooking(h);
    const paymentId = await feePayment(id);
    const event = { eventId: "e1", type: "payment.succeeded", paymentId };

    await handleNotificationEvent(ctx, event);
    await handleNotificationEvent(ctx, event);

    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0].subject).toMatch(/missed-appointment fee of \$25\.00/);
    expect(h.sms.sent).toHaveLength(0);
  });

  test("ignores deposits, refunds, unmatched and unsucceeded payments", async () => {
    const id = await createBooking(h);
    for (const over of [
      { kind: "deposit" as const },
      { kind: "refund" as const },
      { status: "failed" as const },
      { bookingId: null },
    ]) {
      await handleNotificationEvent(ctx, {
        type: "payment.succeeded",
        paymentId: await feePayment(id, over),
      });
    }
    await handleNotificationEvent(ctx, {
      type: "payment.succeeded",
      paymentId: "00000000-0000-4000-8000-000000000000",
    });
    expect(h.email.sent).toHaveLength(0);
  });
});

describe("booking.confirmed", () => {
  test("sends the confirmation messages and schedules the reminder 24h before the start", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { eventId: "e1", type: "booking.confirmed", bookingId: id });

    expect(h.sms.sent).toHaveLength(1);
    expect(h.email.sent).toHaveLength(2);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].queue).toBe(REMINDER_QUEUE);
    expect(jobs[0].startAfter).toEqual(new Date(START.getTime() - 24 * 3_600_000));
    expect(jobs[0].singletonKey).toBe(`reminder:${id}:${START.toISOString()}`);
    expect(jobs[0].data).toEqual({ bookingId: id, expectedStart: START.toISOString() });
  });

  test("notifyClient=false sends only the owner alert and schedules no reminder", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, {
      eventId: "e1",
      type: "booking.confirmed",
      bookingId: id,
      notifyClient: false,
    });
    expect(h.sms.sent).toHaveLength(0);
    expect(h.email.sent).toHaveLength(1);
    expect(jobs).toHaveLength(0);
  });

  test("honours settings.reminderHoursBefore", async () => {
    await h.db
      .update(business)
      .set({ settings: { reminderHoursBefore: 48 } })
      .where(eq(business.id, h.ids.businessId));
    const id = await createBooking(h);
    expect(await scheduleReminder(ctx, id)).toBe("scheduled");
    expect(jobs[0].startAfter).toEqual(new Date(START.getTime() - 48 * 3_600_000));
  });

  test("replaying the event does not double send or double schedule", async () => {
    const id = await createBooking(h);
    const event = { eventId: "e1", type: "booking.confirmed", bookingId: id };
    await handleNotificationEvent(ctx, event);
    await handleNotificationEvent(ctx, event);
    expect(h.sms.sent).toHaveLength(1);
    expect(h.email.sent).toHaveLength(2);
    expect(jobs).toHaveLength(1);
  });

  test("skips the reminder when its send time is already in the past", async () => {
    const id = await createBooking(h);
    h.setNow(new Date(START.getTime() - 3 * 3_600_000));
    expect(await scheduleReminder(ctx, id)).toBe("skipped_past");
    expect(jobs).toHaveLength(0);
  });

  test("does not schedule for a booking that is not confirmed", async () => {
    const id = await createBooking(h, { status: "pending_payment" });
    expect(await scheduleReminder(ctx, id)).toBe("skipped_not_confirmed");
  });

  test("reports a duplicate schedule", async () => {
    const id = await createBooking(h);
    await scheduleReminder(ctx, id);
    expect(await scheduleReminder(ctx, id)).toBe("skipped_duplicate");
  });
});

describe("booking.imported", () => {
  test("schedules the reminder but sends no confirmation or owner alert", async () => {
    const id = await createBooking(h, { depositPaidCents: 0 });
    await h.db.update(booking).set({ source: "import:timely" }).where(eq(booking.id, id));

    await handleNotificationEvent(ctx, { eventId: "i1", type: "booking.imported", bookingId: id });

    expect(h.sms.sent).toHaveLength(0);
    expect(h.email.sent).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].queue).toBe(REMINDER_QUEUE);
    expect(jobs[0].startAfter).toEqual(new Date(START.getTime() - 24 * 3_600_000));
  });

  test("replaying the event does not schedule a second reminder", async () => {
    const id = await createBooking(h, { depositPaidCents: 0 });
    const event = { eventId: "i1", type: "booking.imported", bookingId: id };
    await handleNotificationEvent(ctx, event);
    await handleNotificationEvent(ctx, event);
    expect(jobs).toHaveLength(1);
  });

  test("ignores a malformed event", async () => {
    await handleNotificationEvent(ctx, { type: "booking.imported" });
    expect(jobs).toHaveLength(0);
  });
});

describe("booking.rescheduled", () => {
  const previousStart = "2026-11-13T22:00:00.000Z";

  test("sends 'moved' and schedules a reminder for the new start", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, {
      type: "booking.rescheduled",
      bookingId: id,
      previousStart,
      notifyClient: true,
    });
    expect(h.sms.sent[0].body).toContain("has been moved");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.expectedStart).toBe(START.toISOString());
  });

  test("with notifyClient false the client is not messaged but the reminder is still scheduled", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, {
      type: "booking.rescheduled",
      bookingId: id,
      previousStart,
      notifyClient: false,
    });
    expect(h.sms.sent).toHaveLength(0);
    expect(jobs).toHaveLength(1);
  });

  test("an unparseable previousStart is ignored rather than retried forever", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, {
      type: "booking.rescheduled",
      bookingId: id,
      previousStart: "not a date",
      notifyClient: true,
    });
    expect(h.sms.sent).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  test("the stale reminder for the old time is a no-op while the new one sends", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    const oldJob = jobs[0];

    const newStart = new Date(START.getTime() + 2 * 86_400_000);
    await h.db
      .update(booking)
      .set({ during: { start: newStart, end: new Date(newStart.getTime() + 3_600_000) } })
      .where(eq(booking.id, id));
    await handleNotificationEvent(ctx, {
      type: "booking.rescheduled",
      bookingId: id,
      previousStart: START.toISOString(),
      notifyClient: true,
    });
    expect(jobs).toHaveLength(2);

    h.setNow(new Date(newStart.getTime() - 24 * 3_600_000));
    expect(await handleReminderJob(ctx, oldJob.data)).toBe("skipped");
    expect(await handleReminderJob(ctx, jobs[1].data)).toBe("sent");
    expect(h.sms.sent.filter((m) => m.body.includes("friendly reminder"))).toHaveLength(1);
  });
});

describe("booking.cancelled", () => {
  test("sends cancellation messages stating the deposit outcome", async () => {
    const id = await createBooking(h, { status: "cancelled_by_client" });
    await handleNotificationEvent(ctx, {
      type: "booking.cancelled",
      bookingId: id,
      by: "client",
      depositAction: "keep",
      feeCents: 0,
    });
    expect(h.sms.sent[0].body).toContain("not refundable");
    expect(jobs).toHaveLength(0);
  });

  test("a reminder that fires after the cancel sends nothing", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    await h.db.update(booking).set({ status: "cancelled_by_client" }).where(eq(booking.id, id));
    h.setNow(new Date(START.getTime() - 24 * 3_600_000));
    expect(await handleReminderJob(ctx, jobs[0].data)).toBe("skipped");
    expect(h.sms.sent.filter((m) => m.body.includes("friendly reminder"))).toHaveLength(0);
  });
});

describe("events we do not handle", () => {
  test.each([
    { type: "payment.succeeded", paymentId: "p1" },
    { type: "booking.completed", bookingId: "b1" },
    { type: "client.updated", clientId: "c1" },
    { type: "booking.confirmed" },
    { type: "booking.confirmed", bookingId: "not-a-uuid" },
    null,
    "garbage",
  ])("ignores %j", async (event) => {
    await handleNotificationEvent(ctx, event);
    expect(h.sms.sent).toHaveLength(0);
    expect(h.email.sent).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    expect(await h.db.select().from(messageLog)).toHaveLength(0);
  });
});

describe("reminder job validation", () => {
  test("malformed jobs are dropped, not retried", async () => {
    expect(await handleReminderJob(ctx, { nope: true })).toBe("skipped");
    expect(await handleReminderJob(ctx, { bookingId: "x", expectedStart: "y" })).toBe("skipped");
    const id = await createBooking(h);
    expect(await handleReminderJob(ctx, { bookingId: id, expectedStart: "garbage" })).toBe(
      "skipped",
    );
    expect(h.logs.some((l) => l.event === "reminder_job_invalid")).toBe(true);
    expect(h.logs.some((l) => l.event === "reminder_job_invalid_start")).toBe(true);
  });
});
