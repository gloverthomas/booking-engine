import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { booking, business, client, location, messageLog, payment } from "@/db/schema";
import { verifyManageToken } from "@/server/manage-token";
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingMoved,
  sendBookingReminder,
} from "@/server/notifications/booking-notifications";
import { PermanentSendError } from "@/server/notifications/types";
import { KEY, START, createBooking, createHarness, type Harness } from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function rows() {
  return h.db.select().from(messageLog);
}

describe("booking confirmation", () => {
  test("emails (with .ics) and texts the client, and alerts the owner", async () => {
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);

    const clientEmail = h.email.sent.find((m) => m.to[0] === "sam@example.com");
    expect(clientEmail?.subject).toBe(
      "Your appointment is booked: Saturday 14 November 2026 at 2:15 PM",
    );
    expect(clientEmail?.text).toContain("Northside");
    expect(clientEmail?.text).toContain("12 Smith St, Northcote VIC 3070");
    expect(clientEmail?.text).toContain("Please arrive 10 minutes early.");
    expect(clientEmail?.text).toContain("$62.50");
    expect(clientEmail?.text).toContain(
      "Changes or cancellations within 24 hours of your appointment forfeit your deposit.",
    );

    const ics = clientEmail?.attachments?.[0];
    expect(ics?.filename).toBe("appointment.ics");
    const icsText = Buffer.from(ics?.content ?? []).toString();
    expect(icsText).toContain("BEGIN:VEVENT");
    expect(icsText).toContain("DTSTART:20261114T031500Z");
    expect(icsText).toContain("DTEND:20261114T041500Z"); // 45 + 15 minutes of service; the hidden buffer is excluded
    expect(icsText).toContain(`UID:${id}@booking-engine`);

    expect(h.sms.sent).toHaveLength(1);
    expect(h.sms.sent[0].to).toBe("+61410123456");
    expect(h.sms.sent[0].body).toMatch(
      /^Hi Sam, your appointment with Ryan is booked for Sat, 14 Nov at 2:15PM at Northside 12 Smith St, Northcote VIC 3070\. Manage: https:\/\/book\.example\.com\/manage\/\S+$/,
    );

    const owner = h.email.sent.find((m) => m.to[0] === "owner@example.com");
    expect(owner?.subject).toContain("New booking");
    expect(owner?.attachments).toBeUndefined();
  });

  test("the manage link verifies back to the booking id", async () => {
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    const link = /manage\/(\S+)$/.exec(h.sms.sent[0].body)?.[1] ?? "";
    expect(verifyManageToken(link, KEY)).toBe(id);
    expect(h.email.sent[0].html).toContain(`https://book.example.com/manage/${link}`);
  });

  test("writes a message_log row per send with a dedupe key, status and provider id", async () => {
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    const log = await rows();
    expect(log).toHaveLength(3);
    expect(log.map((r) => r.dedupeKey).sort()).toEqual(
      [`${id}:confirmation:email`, `${id}:confirmation:sms`, `${id}:owner-new:email`].sort(),
    );
    expect(log.every((r) => r.status === "sent" && r.providerMessageId && r.sentAt)).toBe(true);
    expect(log.find((r) => r.channel === "sms")?.toAddress).toBe("+61410123456");
  });

  test("replaying the same event never sends twice", async () => {
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.email.sent).toHaveLength(2); // client + owner, once each
    expect(h.sms.sent).toHaveLength(1);
    expect(await rows()).toHaveLength(3);
  });

  test("does nothing for a booking that is not confirmed or is missing", async () => {
    const pending = await createBooking(h, { status: "pending_payment" });
    expect(await notifyBookingConfirmed(h.db, pending, h.deps)).toEqual([]);
    expect(
      await notifyBookingConfirmed(h.db, "00000000-0000-4000-8000-000000000000", h.deps),
    ).toEqual([]);
    expect(h.email.sent).toHaveLength(0);
    expect(h.sms.sent).toHaveLength(0);
  });

  test("still sends to blocked clients (transactional messages)", async () => {
    await h.db.update(client).set({ blocked: true }).where(eq(client.id, h.ids.clientId));
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.sms.sent).toHaveLength(1);
  });

  test("skips channels the client has no address for", async () => {
    await h.db
      .update(client)
      .set({ email: null, phone: null })
      .where(eq(client.id, h.ids.clientId));
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.sms.sent).toHaveLength(0);
    expect(h.email.sent.map((m) => m.to[0])).toEqual(["owner@example.com"]);
  });

  test("skips the owner alert when OWNER_EMAILS is empty", async () => {
    await h.close();
    h = await createHarness({ config: { ownerEmails: [] } });
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.email.sent.map((m) => m.to[0])).toEqual(["sam@example.com"]);
  });

  test("records an invalid phone number as a permanent failure without calling the provider", async () => {
    await h.db.update(client).set({ phone: "0410 123 456" }).where(eq(client.id, h.ids.clientId));
    const id = await createBooking(h);
    const results = await notifyBookingConfirmed(h.db, id, h.deps);
    expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(h.sms.sent).toHaveLength(0);
    const failed = (await rows()).find((r) => r.channel === "sms");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("not E.164");
  });

  test("uses the custom policy text from settings", async () => {
    await h.db
      .update(business)
      .set({ settings: { policyText: "No refunds inside 48 hours." } })
      .where(eq(business.id, h.ids.businessId));
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.email.sent[0].text).toContain("No refunds inside 48 hours.");
  });

  test("shows the full total as balance when no deposit was paid", async () => {
    const id = await createBooking(h, { depositPaidCents: 0 });
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.email.sent[0].html).not.toContain("Deposit paid");
    expect(h.email.sent[0].text).toContain("$125.00");
  });

  test("warns when the SMS runs past one segment", async () => {
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "sms_multi_segment" }));
  });

  test("keeps SMS plain ASCII even when names and notes are not", async () => {
    await h.db.update(client).set({ firstName: "Zoë" }).where(eq(client.id, h.ids.clientId));
    await h.db
      .update(location)
      .set({ name: "Northside – Studio" })
      .where(eq(location.id, h.ids.locationId));
    const id = await createBooking(h);
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.sms.sent[0].body).toContain("Hi Zoe,");
    expect(h.sms.sent[0].body).toContain("Northside - Studio");
    expect(/^[\x20-\x7E]+$/.test(h.sms.sent[0].body)).toBe(true);
  });
});

describe("failure handling", () => {
  test("a transient SMS failure is recorded, other channels still send, and the error is rethrown for retry", async () => {
    const id = await createBooking(h);
    let failOnce = true;
    const flakySms = {
      send: vi.fn(async (m: { to: string; body: string }) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("ClickSend responded 503");
        }
        h.sms.sent.push(m);
        return { providerMessageId: "ok" };
      }),
    };
    const deps = { ...h.deps, sms: () => flakySms };

    await expect(notifyBookingConfirmed(h.db, id, deps)).rejects.toThrow(/503/);
    expect(h.email.sent).toHaveLength(2); // email + owner went out
    const failed = (await rows()).find((r) => r.channel === "sms");
    expect(failed?.status).toBe("failed");

    // The queue retries the same job: only the failed SMS goes out now.
    await notifyBookingConfirmed(h.db, id, deps);
    expect(h.email.sent).toHaveLength(2);
    expect(h.sms.sent).toHaveLength(1);
    expect((await rows()).every((r) => r.status === "sent")).toBe(true);
    expect(await rows()).toHaveLength(3);
  });

  test("a missing provider key fails at send time with a clear message, not at import", async () => {
    const id = await createBooking(h);
    const deps = {
      ...h.deps,
      sms: () => {
        throw new Error("SMS_PROVIDER is not set (use clicksend, twilio or console)");
      },
    };
    await expect(notifyBookingConfirmed(h.db, id, deps)).rejects.toThrow(/SMS_PROVIDER is not set/);
  });

  test("a permanent provider rejection is logged but does not throw", async () => {
    const id = await createBooking(h);
    const deps = {
      ...h.deps,
      sms: () => ({
        send: async () => {
          throw new PermanentSendError("rejected");
        },
      }),
    };
    const results = await notifyBookingConfirmed(h.db, id, deps);
    expect(results).toContainEqual({ status: "failed", error: "rejected" });
  });
});

describe("booking moved", () => {
  const previousStart = new Date("2026-11-13T22:00:00.000Z"); // Sat 14 Nov 9:00 AM Melbourne

  test("sends moved email + SMS with old and new times, and a higher-sequence .ics", async () => {
    const id = await createBooking(h);
    await notifyBookingMoved(h.db, id, { previousStart, notifyClient: true }, h.deps);

    const mail = h.email.sent.find((m) => m.to[0] === "sam@example.com");
    expect(mail?.subject).toContain("moved to Saturday 14 November 2026 at 2:15 PM");
    expect(mail?.text).toContain("9:00 AM");
    const icsText = Buffer.from(mail?.attachments?.[0].content ?? []).toString();
    expect(icsText).toMatch(/SEQUENCE:\d{9,}/);
    expect(h.sms.sent[0].body).toContain("has been moved to Sat, 14 Nov at 2:15PM");
    expect(h.email.sent.find((m) => m.to[0] === "owner@example.com")?.subject).toContain(
      "Booking moved",
    );
  });

  test("with notifyClient false only the owner is told", async () => {
    const id = await createBooking(h);
    await notifyBookingMoved(h.db, id, { previousStart, notifyClient: false }, h.deps);
    expect(h.sms.sent).toHaveLength(0);
    expect(h.email.sent.map((m) => m.to[0])).toEqual(["owner@example.com"]);
  });

  test("moving twice to different times messages twice, replaying one move does not", async () => {
    const id = await createBooking(h);
    await notifyBookingMoved(h.db, id, { previousStart, notifyClient: true }, h.deps);
    await notifyBookingMoved(h.db, id, { previousStart, notifyClient: true }, h.deps);
    expect(h.sms.sent).toHaveLength(1);

    const later = new Date(START.getTime() + 86_400_000);
    await h.db
      .update(booking)
      .set({ during: { start: later, end: new Date(later.getTime() + 3_600_000) } })
      .where(eq(booking.id, id));
    await notifyBookingMoved(h.db, id, { previousStart: START, notifyClient: true }, h.deps);
    expect(h.sms.sent).toHaveLength(2);
  });

  test("ignores a booking that is no longer confirmed or no longer exists", async () => {
    const id = await createBooking(h, { status: "cancelled_by_client" });
    expect(
      await notifyBookingMoved(h.db, id, { previousStart, notifyClient: true }, h.deps),
    ).toEqual([]);
    expect(
      await notifyBookingMoved(
        h.db,
        "00000000-0000-4000-8000-000000000000",
        { previousStart, notifyClient: true },
        h.deps,
      ),
    ).toEqual([]);
  });
});

describe("booking cancelled", () => {
  test("refund: tells the client the deposit is being refunded", async () => {
    const id = await createBooking(h, { status: "cancelled_by_client" });
    await notifyBookingCancelled(
      h.db,
      id,
      { by: "client", depositAction: "refund", feeCents: 0 },
      h.deps,
    );
    const mail = h.email.sent.find((m) => m.to[0] === "sam@example.com");
    expect(mail?.text).toContain("Your deposit of $62.50 is being refunded");
    expect(h.sms.sent[0].body).toContain("has been cancelled. Your deposit is being refunded.");
    expect(h.sms.sent[0].body).toContain("https://book.example.com/book");
    expect(h.email.sent.find((m) => m.to[0] === "owner@example.com")?.text).toContain("refunded");
  });

  test("late cancellation: deposit kept and fee mentioned", async () => {
    const id = await createBooking(h, { status: "late_cancelled" });
    await notifyBookingCancelled(
      h.db,
      id,
      { by: "client", depositAction: "keep", feeCents: 2500 },
      h.deps,
    );
    const mail = h.email.sent.find((m) => m.to[0] === "sam@example.com");
    expect(mail?.text).toContain("Your deposit of $62.50 is not refunded");
    expect(mail?.text).toContain("$25.00");
    expect(h.sms.sent[0].body).toContain("not refundable");
  });

  test("no deposit paid: says there is nothing to refund even if the event says refund", async () => {
    const id = await createBooking(h, { status: "cancelled_by_staff", depositPaidCents: 0 });
    await notifyBookingCancelled(
      h.db,
      id,
      { by: "staff", depositAction: "refund", feeCents: 0 },
      h.deps,
    );
    const mail = h.email.sent.find((m) => m.to[0] === "sam@example.com");
    expect(mail?.text).toContain("No deposit was taken");
    expect(mail?.text).toContain("we have had to cancel");
    expect(h.sms.sent[0].body).not.toContain("deposit");
  });

  test("a refunded deposit still counts as paid when explaining the outcome", async () => {
    const id = await createBooking(h, { status: "cancelled_by_client" });
    await h.db.update(payment).set({ status: "refunded" }).where(eq(payment.bookingId, id));
    await notifyBookingCancelled(
      h.db,
      id,
      { by: "client", depositAction: "refund", feeCents: 0 },
      h.deps,
    );
    expect(h.email.sent[0].text).toContain("$62.50");
  });

  test("replays and missing bookings are harmless", async () => {
    const id = await createBooking(h, { status: "cancelled_by_client" });
    const details = { by: "client", depositAction: "none", feeCents: 0 } as const;
    await notifyBookingCancelled(h.db, id, details, h.deps);
    await notifyBookingCancelled(h.db, id, details, h.deps);
    expect(h.sms.sent).toHaveLength(1);
    expect(
      await notifyBookingCancelled(h.db, "00000000-0000-4000-8000-000000000000", details, h.deps),
    ).toEqual([]);
  });
});

describe("reminder", () => {
  test("sends the day-before SMS in Timely's wording, including the arrival note", async () => {
    const id = await createBooking(h);
    h.setNow(new Date("2026-11-13T03:00:00.000Z"));
    expect(await sendBookingReminder(h.db, id, START, h.deps)).toBe("sent");
    expect(h.sms.sent[0].body).toMatch(
      /^Hi Sam, this is a friendly reminder of your appointment with Ryan on Sat, 14 Nov at 2:15PM at Northside 12 Smith St, Northcote VIC 3070\. Please arrive 10 minutes early\. https:\/\/book\.example\.com\/manage\/\S+$/,
    );
    expect(h.email.sent).toHaveLength(0);
  });

  test("is idempotent", async () => {
    const id = await createBooking(h);
    await sendBookingReminder(h.db, id, START, h.deps);
    expect(await sendBookingReminder(h.db, id, START, h.deps)).toBe("skipped");
    expect(h.sms.sent).toHaveLength(1);
  });

  test("skips when the booking was rescheduled after the job was queued", async () => {
    const id = await createBooking(h);
    const later = new Date(START.getTime() + 3_600_000);
    await h.db
      .update(booking)
      .set({ during: { start: later, end: new Date(later.getTime() + 3_600_000) } })
      .where(eq(booking.id, id));
    expect(await sendBookingReminder(h.db, id, START, h.deps)).toBe("skipped");
    expect(h.sms.sent).toHaveLength(0);
    // ...while the reminder for the new time does go out.
    expect(await sendBookingReminder(h.db, id, later, h.deps)).toBe("sent");
  });

  test("skips when cancelled, when the appointment has already started, and when the booking is gone", async () => {
    const cancelled = await createBooking(h, { status: "cancelled_by_client" });
    expect(await sendBookingReminder(h.db, cancelled, START, h.deps)).toBe("skipped");

    const id = await createBooking(h, { start: new Date("2026-12-01T03:00:00.000Z") });
    h.setNow(new Date("2026-12-02T00:00:00.000Z"));
    expect(await sendBookingReminder(h.db, id, new Date("2026-12-01T03:00:00.000Z"), h.deps)).toBe(
      "skipped",
    );
    expect(
      await sendBookingReminder(h.db, "00000000-0000-4000-8000-000000000000", START, h.deps),
    ).toBe("skipped");
    expect(h.sms.sent).toHaveLength(0);
  });

  test("skipped without a phone number", async () => {
    await h.db.update(client).set({ phone: null }).where(eq(client.id, h.ids.clientId));
    const id = await createBooking(h);
    expect(await sendBookingReminder(h.db, id, START, h.deps)).toBe("skipped");
  });
});
