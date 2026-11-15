import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { booking, business, messageLog, staff } from "@/db/schema";
import {
  handleNotificationEvent,
  type EventHandlerContext,
  type JobScheduler,
} from "@/server/notifications/handle-event";
import type { SmsProvider } from "@/server/notifications/types";
import { createStaff } from "../helpers/factories";
import { createBooking, createHarness, START, type Harness } from "./helpers";

const scheduler: JobScheduler = { send: async () => "job" };

let h: Harness;
let ctx: EventHandlerContext;
type Notifier = NonNullable<EventHandlerContext["notifyWaitlistOffer"]>;
let notifyWaitlistOffer: ReturnType<typeof vi.fn<Notifier>>;

const ALEX_PHONE = "+61411222333";

beforeEach(async () => {
  h = await createHarness();
  notifyWaitlistOffer = vi.fn<Notifier>(async () => []);
  ctx = { db: h.db, deps: h.deps, scheduler, notifyWaitlistOffer };
  await h.db
    .update(staff)
    .set({ name: "Ryan Kennedy", email: "ryan@example.com", phone: "+61400111222" })
    .where(eq(staff.id, h.ids.staffId));
});
afterEach(async () => {
  await h.close();
});

const emailsTo = (address: string) => h.email.sent.filter((m) => m.to.includes(address));
const smsTo = (phone: string) => h.sms.sent.filter((m) => m.to === phone);

async function alex() {
  return createStaff(h.db, h.ids.businessId, {
    name: "Alex Rowe",
    email: "alex@example.com",
    phone: ALEX_PHONE,
  });
}

describe("staff alerts: booking.confirmed", () => {
  test("emails and texts the booking's stylist with name, services, local time and place", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });

    const [mail] = emailsTo("ryan@example.com");
    expect(mail.subject).toBe("New booking: Sam, Saturday 14 November 2026 2:15 PM");
    expect(mail.text).toContain("Hi Ryan");
    expect(mail.text).toContain("Maintenance Haircut, Beard Trim");
    expect(mail.text).toContain("Northside");

    const [text] = smsTo("+61400111222");
    expect(text.body).toBe(
      "New booking: Sam, Maintenance Haircut, Beard Trim, Sat, 14 Nov 2:15PM, Northside 12 Smith St, Northcote VIC 3070.",
    );
  });

  test("never includes the client's phone or email", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    const everything = [
      ...emailsTo("ryan@example.com").flatMap((m) => [m.subject, m.html, m.text]),
      ...smsTo("+61400111222").map((m) => m.body),
    ].join("\n");
    expect(everything).not.toContain("sam@example.com");
    expect(everything).not.toContain("+61410123456");
    expect(everything).not.toContain("0410 123 456");
  });

  test("is idempotent: a replay sends nothing more", async () => {
    const id = await createBooking(h);
    const event = { eventId: "e1", type: "booking.confirmed", bookingId: id };
    await handleNotificationEvent(ctx, event);
    await handleNotificationEvent(ctx, event);
    expect(emailsTo("ryan@example.com")).toHaveLength(1);
    expect(smsTo("+61400111222")).toHaveLength(1);
  });

  test("still alerts the stylist when the client is not being told", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, {
      type: "booking.confirmed",
      bookingId: id,
      notifyClient: false,
    });
    expect(emailsTo("ryan@example.com")).toHaveLength(1);
    expect(h.sms.sent.filter((m) => m.to === "+61410123456")).toHaveLength(0);
  });

  test("does nothing when staffAlertsEnabled is off", async () => {
    await h.db
      .update(business)
      .set({ settings: { staffAlertsEnabled: false, cancelWindowHours: 24 } });
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    expect(emailsTo("ryan@example.com")).toHaveLength(0);
    expect(smsTo("+61400111222")).toHaveLength(0);
  });

  test("does not double-email a stylist who is already an owner-alert recipient; SMS still goes", async () => {
    const owner = await createHarness({ config: { ownerEmails: ["Ryan@Example.com"] } });
    try {
      await owner.db
        .update(staff)
        .set({ email: "ryan@example.com", phone: "+61400111222" })
        .where(eq(staff.id, owner.ids.staffId));
      const id = await createBooking(owner);
      await handleNotificationEvent(
        { db: owner.db, deps: owner.deps, scheduler, notifyWaitlistOffer },
        { type: "booking.confirmed", bookingId: id },
      );
      const toRyan = owner.email.sent.filter((m) => m.to.includes("ryan@example.com"));
      expect(toRyan).toHaveLength(0);
      expect(owner.email.sent.filter((m) => m.to.includes("Ryan@Example.com"))).toHaveLength(1); // owner alert only
      expect(owner.sms.sent.filter((m) => m.to === "+61400111222")).toHaveLength(1);
    } finally {
      await owner.close();
    }
  });

  test("a stylist with no phone gets email only; with no email gets SMS only; with neither, nothing", async () => {
    await h.db.update(staff).set({ phone: null }).where(eq(staff.id, h.ids.staffId));
    const first = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: first });
    expect(emailsTo("ryan@example.com")).toHaveLength(1);
    expect(smsTo("+61400111222")).toHaveLength(0);

    await h.db
      .update(staff)
      .set({ email: null, phone: "+61400111222" })
      .where(eq(staff.id, h.ids.staffId));
    const second = await createBooking(h, { start: new Date(START.getTime() + 86_400_000) });
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: second });
    expect(smsTo("+61400111222")).toHaveLength(1);

    await h.db.update(staff).set({ phone: null }).where(eq(staff.id, h.ids.staffId));
    const third = await createBooking(h, { start: new Date(START.getTime() + 2 * 86_400_000) });
    const before = h.email.sent.length + h.sms.sent.length;
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: third });
    // Only the client's and owner's messages went out (3 of them), none to the stylist.
    expect(h.email.sent.length + h.sms.sent.length - before).toBe(3);
  });

  test("skips SMS quietly when no SMS provider is configured", async () => {
    const noSms = {
      ...h.deps,
      sms: (): SmsProvider => {
        throw new Error("SMS_PROVIDER is not set");
      },
    };
    const id = await createBooking(h);
    await handleNotificationEvent(
      { db: h.db, deps: noSms, scheduler, notifyWaitlistOffer },
      { type: "booking.confirmed", bookingId: id, notifyClient: false },
    ).catch(() => undefined);
    expect(emailsTo("ryan@example.com")).toHaveLength(1);
    expect(h.logs.some((l) => l.event === "staff_alert_sms_skipped_no_provider")).toBe(true);
  });

  test("a bad staff phone number is recorded as failed without breaking the event", async () => {
    await h.db.update(staff).set({ phone: "0400 111 222" }).where(eq(staff.id, h.ids.staffId));
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    expect(emailsTo("ryan@example.com")).toHaveLength(1);
    const rows = await h.db.select().from(messageLog).where(eq(messageLog.channel, "sms"));
    expect(rows.filter((r) => r.template === "staff_alert_new")[0].status).toBe("failed");
  });

  test("a hold that is not confirmed gets no alert", async () => {
    const id = await createBooking(h, { status: "pending_payment" });
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    expect(emailsTo("ryan@example.com")).toHaveLength(0);
  });

  test("a failure sending to the client does not stop the stylist alert, and the event is retried", async () => {
    const id = await createBooking(h);
    let fail = true;
    const flaky = {
      ...h.deps,
      email: () => ({
        send: async (message: Parameters<typeof h.email.send>[0]) => {
          if (fail && message.to.includes("sam@example.com")) throw new Error("resend down");
          return h.email.send(message);
        },
      }),
    };
    const flakyCtx = { ...ctx, deps: flaky };
    await expect(
      handleNotificationEvent(flakyCtx, { type: "booking.confirmed", bookingId: id }),
    ).rejects.toThrow("resend down");
    expect(emailsTo("ryan@example.com")).toHaveLength(1);

    fail = false;
    await handleNotificationEvent(flakyCtx, { type: "booking.confirmed", bookingId: id });
    expect(emailsTo("ryan@example.com")).toHaveLength(1); // not repeated
    expect(emailsTo("sam@example.com")).toHaveLength(1);
  });
});

describe("staff alerts: booking.cancelled", () => {
  test("tells the stylist, once", async () => {
    const id = await createBooking(h, { status: "cancelled_by_client" });
    const event = {
      type: "booking.cancelled",
      bookingId: id,
      by: "client",
      depositAction: "refund",
      feeCents: 0,
    };
    await handleNotificationEvent(ctx, event);
    await handleNotificationEvent(ctx, event);
    const mails = emailsTo("ryan@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^Booking cancelled: Sam/);
    expect(smsTo("+61400111222")[0].body).toMatch(/^Booking cancelled: Sam/);
  });
});

describe("staff alerts: booking.rescheduled", () => {
  const moved = (id: string, extra: Record<string, unknown> = {}) => ({
    eventId: "ev-1",
    type: "booking.rescheduled",
    bookingId: id,
    previousStart: new Date(START.getTime() - 86_400_000).toISOString(),
    notifyClient: false,
    ...extra,
  });

  test("same stylist, new time: 'moved' with the previous time", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, moved(id));
    const [mail] = emailsTo("ryan@example.com");
    expect(mail.subject).toMatch(/^Booking moved: Sam/);
    expect(mail.text).toContain("Previously");
    expect(mail.text).toContain("Friday 13 November 2026");
  });

  test("a new time sent twice only alerts once; a second move alerts again", async () => {
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, moved(id));
    await handleNotificationEvent(ctx, moved(id));
    expect(emailsTo("ryan@example.com")).toHaveLength(1);

    const later = new Date(START.getTime() + 3_600_000);
    await h.db
      .update(booking)
      .set({ during: { start: later, end: new Date(later.getTime() + 75 * 60_000) } })
      .where(eq(booking.id, id));
    await handleNotificationEvent(ctx, moved(id, { eventId: "ev-2" }));
    expect(emailsTo("ryan@example.com")).toHaveLength(2);
  });

  test("stylist changed: the new stylist is 'assigned', the previous one 'moved away' from the lost slot", async () => {
    const other = await alex();
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    expect(emailsTo("ryan@example.com")).toHaveLength(1);

    await h.db.update(booking).set({ staffId: other.id }).where(eq(booking.id, id));
    await handleNotificationEvent(ctx, moved(id, { previousStart: START.toISOString() }));

    const [assigned] = emailsTo("alex@example.com");
    expect(assigned.subject).toMatch(/^Booking assigned to you: Sam/);
    expect(smsTo(ALEX_PHONE)[0].body).toMatch(/^Booking assigned to you: Sam/);

    const away = emailsTo("ryan@example.com")[1];
    expect(away.subject).toMatch(
      /^Booking moved away from you: Sam, Saturday 14 November 2026 2:15 PM/,
    );
    expect(smsTo("+61400111222")[1].body).toMatch(/^Booking moved away from you/);

    // Replaying the same event repeats nothing, and is not mistaken for a plain time change.
    await handleNotificationEvent(ctx, moved(id, { previousStart: START.toISOString() }));
    expect(emailsTo("alex@example.com")).toHaveLength(1);
    expect(emailsTo("ryan@example.com")).toHaveLength(2);
  });

  test("after a reassignment the new stylist's later time change is a plain 'moved'", async () => {
    const other = await alex();
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    await h.db.update(booking).set({ staffId: other.id }).where(eq(booking.id, id));
    await handleNotificationEvent(ctx, moved(id, { previousStart: START.toISOString() }));
    await handleNotificationEvent(ctx, moved(id, { eventId: "ev-2" }));
    expect(emailsTo("alex@example.com").map((m) => m.subject.split(":")[0])).toEqual([
      "Booking assigned to you",
      "Booking moved",
    ]);
    expect(emailsTo("ryan@example.com")).toHaveLength(2); // new + moved away, nothing more
  });

  test("moving back to the first stylist tells both again", async () => {
    const other = await alex();
    const id = await createBooking(h);
    await handleNotificationEvent(ctx, { type: "booking.confirmed", bookingId: id });
    await h.db.update(booking).set({ staffId: other.id }).where(eq(booking.id, id));
    await handleNotificationEvent(ctx, moved(id, { previousStart: START.toISOString() }));
    await h.db.update(booking).set({ staffId: h.ids.staffId }).where(eq(booking.id, id));
    await handleNotificationEvent(
      ctx,
      moved(id, { eventId: "ev-2", previousStart: START.toISOString() }),
    );
    expect(emailsTo("ryan@example.com").map((m) => m.subject.split(":")[0])).toEqual([
      "New booking",
      "Booking moved away from you",
      "Booking assigned to you",
    ]);
    expect(emailsTo("alex@example.com").map((m) => m.subject.split(":")[0])).toEqual([
      "Booking assigned to you",
      "Booking moved away from you",
    ]);
  });

  test("uses previousStaffId when the event supplies it, even with no alert history", async () => {
    const other = await alex();
    const id = await createBooking(h);
    await h.db.update(booking).set({ staffId: other.id }).where(eq(booking.id, id));
    await handleNotificationEvent(
      ctx,
      moved(id, { previousStart: START.toISOString(), previousStaffId: h.ids.staffId }),
    );
    expect(emailsTo("alex@example.com")[0].subject).toMatch(/^Booking assigned to you/);
    expect(emailsTo("ryan@example.com")[0].subject).toMatch(/^Booking moved away from you/);
  });

  test("a cancelled booking is not announced as moved", async () => {
    const id = await createBooking(h, { status: "cancelled_by_staff" });
    await handleNotificationEvent(ctx, moved(id));
    expect(emailsTo("ryan@example.com")).toHaveLength(0);
  });
});

describe("event routing", () => {
  test("waitlist.offer_created calls notifyWaitlistOffer with the offer id", async () => {
    const offerId = "11111111-1111-4111-8111-111111111111";
    await handleNotificationEvent(ctx, { type: "waitlist.offer_created", offerId });
    expect(notifyWaitlistOffer).toHaveBeenCalledWith(h.db, offerId, h.deps);
  });

  test("a failing waitlist notification propagates so the queue retries", async () => {
    notifyWaitlistOffer.mockRejectedValueOnce(new Error("sms down"));
    await expect(
      handleNotificationEvent(ctx, {
        type: "waitlist.offer_created",
        offerId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow("sms down");
  });

  test("booking.expired and unknown events are ignored", async () => {
    const id = await createBooking(h, { status: "expired" });
    await handleNotificationEvent(ctx, { type: "booking.expired", bookingId: id });
    await handleNotificationEvent(ctx, { type: "waitlist.entry_joined", entryId: "x" });
    await handleNotificationEvent(ctx, { type: "something.else" });
    expect(h.email.sent).toHaveLength(0);
    expect(h.sms.sent).toHaveLength(0);
    expect(notifyWaitlistOffer).not.toHaveBeenCalled();
  });
});
