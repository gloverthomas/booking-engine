import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { client, messageLog, waitlistOffer } from "@/db/schema";
import {
  notifyWaitlistOffer,
  smsWaitlistOffer,
  waitlistLinks,
} from "@/server/notifications/waitlist-notifications";
import { renderWaitlistOffer } from "@/emails";
import { getOfferView } from "@/server/waitlist";
import {
  createMemoryEmailSender,
  createMemorySmsProvider,
} from "@/server/notifications/providers/memory";
import type { NotificationDeps } from "@/server/notifications/types";
import { createWorld, type World } from "../availability/setup";
import { KEY, NOW, join, offerTo, opts, person, tokenFor } from "./setup";

let w: World;
const email = createMemoryEmailSender();
const sms = createMemorySmsProvider();
const logs: Array<Record<string, unknown>> = [];
let now = NOW;
const deps: NotificationDeps = {
  email: () => email,
  sms: () => sms,
  config: () => ({ appUrl: "https://book.example.com", encryptionKey: KEY, ownerEmails: [] }),
  now: () => now,
  log: (entry) => logs.push(entry),
};

beforeEach(async () => {
  w = await createWorld({ cancelWindowHours: 24 });
  email.sent.length = 0;
  sms.sent.length = 0;
  logs.length = 0;
  now = NOW;
});
afterEach(async () => {
  await w.t.client.close();
});

async function offered() {
  const { entryId } = await join(w, { client: person(1) });
  const { offerId } = await offerTo(w, entryId);
  return { entryId, offerId };
}

describe("notifyWaitlistOffer", () => {
  test("sends an email and an SMS with the claim and leave links", async () => {
    const { entryId, offerId } = await offered();
    const results = await notifyWaitlistOffer(w.db, offerId, deps);

    expect(results.map((r) => r.status)).toEqual(["sent", "sent"]);
    const [mail] = email.sent;
    const [text] = sms.sent;
    const claim = `https://book.example.com/waitlist/claim/${tokenFor(offerId)}`;
    const leave = `https://book.example.com/waitlist/leave/${tokenFor(entryId)}`;

    expect(mail.to).toEqual(["person1@example.com"]);
    expect(mail.subject).toBe("A time has opened up: Monday 2 November 2026 at 10:00 AM");
    expect(mail.html).toContain(claim);
    expect(mail.html).toContain(leave);
    expect(mail.text).toContain("Maintenance Haircut");
    expect(mail.text).toContain("$47.50");
    expect(mail.text).toContain("20 minutes");
    expect(mail.text).toContain("Northside");

    expect(text.to).toMatch(/^\+61/);
    expect(text.body).toContain("a time has opened up with Ryan");
    expect(text.body).toContain("Mon, 2 Nov at 10:00AM");
    expect(text.body).toContain("$47.50 deposit");
    expect(text.body).toContain("held 20 min");
    expect(text.body).toContain(claim);
    expect(text.body).toContain(leave);
  });

  test("is idempotent per offer", async () => {
    const { offerId } = await offered();
    await notifyWaitlistOffer(w.db, offerId, deps);
    const again = await notifyWaitlistOffer(w.db, offerId, deps);
    expect(again.map((r) => r.status)).toEqual(["duplicate", "duplicate"]);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    const rows = await w.db.select().from(messageLog);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([
      `waitlist-offer:${offerId}:email`,
      `waitlist-offer:${offerId}:sms`,
    ]);
  });

  test("skips offers that are no longer open", async () => {
    const { offerId } = await offered();
    await w.db
      .update(waitlistOffer)
      .set({ status: "slot_taken" })
      .where(eq(waitlistOffer.id, offerId));
    expect(await notifyWaitlistOffer(w.db, offerId, deps)).toEqual([]);
    now = new Date(NOW.getTime() + 60 * 60_000);
    expect(await notifyWaitlistOffer(w.db, offerId, deps)).toEqual([]);
    expect(email.sent).toHaveLength(0);
  });

  test("skips an unknown offer", async () => {
    expect(await notifyWaitlistOffer(w.db, "6f1c8d3e-1111-4222-8333-444455556666", deps)).toEqual(
      [],
    );
  });

  test("sends only SMS without an email address, and only email without a phone", async () => {
    const { offerId } = await offered();
    await w.db.update(client).set({ email: null });
    expect((await notifyWaitlistOffer(w.db, offerId, deps)).map((r) => r.status)).toEqual(["sent"]);
    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(1);

    const second = await offered2();
    await w.db.update(client).set({ phone: null }).where(eq(client.email, "person2@example.com"));
    await notifyWaitlistOffer(w.db, second, deps);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
  });

  test("a non-E.164 phone is a recorded permanent failure, not a retry", async () => {
    const { offerId } = await offered();
    await w.db.update(client).set({ phone: "0410 000 001" });
    const results = await notifyWaitlistOffer(w.db, offerId, deps);
    expect(results.map((r) => r.status)).toEqual(["sent", "failed"]);
  });
});

async function offered2() {
  const { entryId } = await join(w, { client: person(2), latestDate: "2026-11-05" });
  const { offerId } = await offerTo(w, entryId);
  return offerId;
}

describe("templates", () => {
  test("renders brand email props", async () => {
    const { offerId } = await offered();
    const view = await getOfferView(w.db, tokenFor(offerId), NOW, opts);
    expect(view).not.toBeNull();
    const rendered = await renderWaitlistOffer({
      businessName: "Ryan Kennedy",
      firstName: "Sam",
      staffName: "Ryan",
      dateLabel: "Monday 2 November 2026",
      timeLabel: "10:00 AM",
      services: [{ name: "Cut", price: "$95.00" }],
      totalLabel: "$95.00",
      locationName: "Northside",
      address: "12 Smith St",
      depositLabel: "$47.50",
      windowLabel: "20 minutes",
      heldUntilLabel: "10:20 AM",
      claimUrl: "https://x.test/claim",
      leaveUrl: "https://x.test/leave",
    });
    expect(rendered.html).toContain("A time has opened up");
    expect(rendered.html).toContain("text-transform:uppercase");
    expect(rendered.text).toContain("Claim this time");
  });

  test("helpers build links from the config", () => {
    const links = waitlistLinks(deps, "o1", "e1");
    expect(links.claimUrl).toMatch(/^https:\/\/book\.example\.com\/waitlist\/claim\/o1\./);
    expect(links.leaveUrl).toMatch(/^https:\/\/book\.example\.com\/waitlist\/leave\/e1\./);
    expect(
      smsWaitlistOffer(
        "Sam",
        {
          start: NOW,
          timezone: "Australia/Melbourne",
          staffName: "Ryan",
          locationName: "N",
          depositCents: 100,
        } as never,
        links,
        5,
      ),
    ).toContain("held 5 min");
  });
});
