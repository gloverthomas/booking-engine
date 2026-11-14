import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, client, messageLog } from "@/db/schema";
import { resendConfirmation, sendInvoiceEmail, sendOneOffMessage } from "@/server/notifications";
import { PermanentSendError } from "@/server/notifications/types";
import { createBooking, createHarness, type Harness } from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const MISSING = "00000000-0000-4000-8000-000000000000";

describe("resendConfirmation", () => {
  test("sends the client email and SMS again even after the original went out, without alerting the owner", async () => {
    const id = await createBooking(h);
    const { notifyBookingConfirmed } = await import("@/server/notifications/booking-notifications");
    await notifyBookingConfirmed(h.db, id, h.deps);
    expect(h.email.sent).toHaveLength(2);

    h.setNow(new Date(h.deps.now().getTime() + 1000));
    await resendConfirmation(h.db, id, h.deps);
    expect(h.email.sent).toHaveLength(3);
    expect(h.email.sent[2].to).toEqual(["sam@example.com"]);
    expect(h.sms.sent).toHaveLength(2);
    expect(h.email.sent[2].attachments?.[0].filename).toBe("appointment.ics");
  });

  test("writes an audit row with the system actor", async () => {
    const id = await createBooking(h);
    await resendConfirmation(h.db, id, h.deps);
    const [row] = await h.db.select().from(auditLog);
    expect(row).toMatchObject({
      actor: "system",
      action: "notification.resend_confirmation",
      entityType: "booking",
      entityId: id,
    });
  });

  test("rejects unknown and unconfirmed bookings", async () => {
    await expect(resendConfirmation(h.db, MISSING, h.deps)).rejects.toThrow(/not found/);
    const cancelled = await createBooking(h, { status: "cancelled_by_staff" });
    await expect(resendConfirmation(h.db, cancelled, h.deps)).rejects.toThrow(/Only confirmed/);
  });

  test("surfaces a permanent failure to the admin", async () => {
    const id = await createBooking(h);
    const deps = {
      ...h.deps,
      sms: () => ({
        send: async () => {
          throw new PermanentSendError("number is not a mobile");
        },
      }),
    };
    await expect(resendConfirmation(h.db, id, deps)).rejects.toThrow(/not a mobile/);
  });
});

describe("sendOneOffMessage", () => {
  test("emails the client with the given subject and logs it without a dedupe key", async () => {
    await sendOneOffMessage(
      h.db,
      {
        clientId: h.ids.clientId,
        channel: "email",
        subject: "Running late",
        body: "Hi Sam,\n\nI am running 10 minutes late.\nSee you soon",
      },
      h.deps,
    );
    expect(h.email.sent[0].subject).toBe("Running late");
    expect(h.email.sent[0].to).toEqual(["sam@example.com"]);
    expect(h.email.sent[0].text).toContain("I am running 10 minutes late.");
    const [row] = await h.db.select().from(messageLog);
    expect(row).toMatchObject({
      template: "one_off",
      dedupeKey: null,
      status: "sent",
      bookingId: null,
    });
  });

  test("uses a default subject and can be sent repeatedly", async () => {
    const input = { clientId: h.ids.clientId, channel: "email", body: "Hello" } as const;
    await sendOneOffMessage(h.db, input, h.deps);
    await sendOneOffMessage(h.db, input, h.deps);
    expect(h.email.sent).toHaveLength(2);
    expect(h.email.sent[0].subject).toBe("A message from Ryan Kennedy Hairdressing");
  });

  test("texts the client as plain ASCII", async () => {
    await sendOneOffMessage(
      h.db,
      { clientId: h.ids.clientId, channel: "sms", body: "Hi Sam, I’m running late – sorry!" },
      h.deps,
    );
    expect(h.sms.sent).toEqual([{ to: "+61410123456", body: "Hi Sam, I'm running late - sorry!" }]);
    const [audit] = await h.db.select().from(auditLog);
    expect(audit).toMatchObject({
      actor: "system",
      action: "notification.one_off",
      entityType: "client",
    });
    expect(JSON.stringify(audit.data)).not.toContain("running late");
  });

  test("clear errors for missing client, empty body and missing address", async () => {
    await expect(
      sendOneOffMessage(h.db, { clientId: MISSING, channel: "sms", body: "x" }, h.deps),
    ).rejects.toThrow(/Client not found/);
    await expect(
      sendOneOffMessage(h.db, { clientId: h.ids.clientId, channel: "sms", body: "   " }, h.deps),
    ).rejects.toThrow(/empty/);
    await h.db
      .update(client)
      .set({ phone: null, email: null })
      .where(eq(client.id, h.ids.clientId));
    await expect(
      sendOneOffMessage(h.db, { clientId: h.ids.clientId, channel: "sms", body: "x" }, h.deps),
    ).rejects.toThrow(/no mobile/);
    await expect(
      sendOneOffMessage(h.db, { clientId: h.ids.clientId, channel: "email", body: "x" }, h.deps),
    ).rejects.toThrow(/no email/);
  });

  test("an invalid stored phone number is reported, not sent", async () => {
    await h.db.update(client).set({ phone: "0410123456" }).where(eq(client.id, h.ids.clientId));
    await expect(
      sendOneOffMessage(h.db, { clientId: h.ids.clientId, channel: "sms", body: "x" }, h.deps),
    ).rejects.toThrow(/not E.164/);
    expect(h.sms.sent).toHaveLength(0);
  });
});

describe("sendInvoiceEmail", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  test("emails the invoice with the PDF attached", async () => {
    const id = await createBooking(h);
    await sendInvoiceEmail(h.db, { bookingId: id, invoiceNumber: "INV-0042", pdf }, h.deps);
    const mail = h.email.sent[0];
    expect(mail.to).toEqual(["sam@example.com"]);
    expect(mail.subject).toBe("Your invoice INV-0042 from Ryan Kennedy Hairdressing");
    expect(mail.attachments?.[0]).toMatchObject({
      filename: "Invoice-INV-0042.pdf",
      contentType: "application/pdf",
    });
    expect(Array.from(mail.attachments?.[0].content ?? [])).toEqual(Array.from(pdf));
  });

  test("is idempotent per invoice number", async () => {
    const id = await createBooking(h);
    const input = { bookingId: id, invoiceNumber: "INV-0042", pdf };
    await sendInvoiceEmail(h.db, input, h.deps);
    await sendInvoiceEmail(h.db, input, h.deps);
    expect(h.email.sent).toHaveLength(1);
  });

  test("sanitises the invoice number in the filename", async () => {
    const id = await createBooking(h);
    await sendInvoiceEmail(h.db, { bookingId: id, invoiceNumber: "INV/42 ../x", pdf }, h.deps);
    expect(h.email.sent[0].attachments?.[0].filename).toBe("Invoice-INV_42_.._x.pdf");
  });

  test("a client without an email is skipped quietly; an unknown booking throws", async () => {
    await h.db.update(client).set({ email: null }).where(eq(client.id, h.ids.clientId));
    const id = await createBooking(h);
    await sendInvoiceEmail(h.db, { bookingId: id, invoiceNumber: "INV-1", pdf }, h.deps);
    expect(h.email.sent).toHaveLength(0);
    await expect(
      sendInvoiceEmail(h.db, { bookingId: MISSING, invoiceNumber: "INV-1", pdf }, h.deps),
    ).rejects.toThrow(/not found/);
  });
});
