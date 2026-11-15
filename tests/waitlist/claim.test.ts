import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { booking, waitlistOffer } from "@/db/schema";
import {
  NotFoundError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
} from "@/server/booking";
import {
  OfferGoneError,
  claimOffer,
  getOfferByToken,
  getOfferView,
  loadBillingDetails,
} from "@/server/waitlist";
import { createWorld, setSettings, type World } from "../availability/setup";
import {
  KEY,
  NOW,
  bookedSlot,
  entryRow,
  events,
  join,
  offerRow,
  offerTo,
  opts,
  person,
  tokenFor,
} from "./setup";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

const claim = (token: string, now = NOW, policyVersion?: string | null) =>
  claimOffer(w.db, token, now, {
    ...opts,
    policyVersion: policyVersion === null ? undefined : (policyVersion ?? "1"),
  });

async function offered(n = 1) {
  const { entryId } = await join(w, { client: person(n) });
  const { offerId } = await offerTo(w, entryId);
  return { entryId, offerId, token: tokenFor(offerId) };
}

describe("getOfferByToken / getOfferView", () => {
  test("describes a live offer with prices and the deposit", async () => {
    const { offerId, entryId, token } = await offered();
    const summary = await getOfferByToken(w.db, token, NOW, opts);
    expect(summary).toMatchObject({
      offerId,
      entryId,
      status: "sent",
      locationName: "Northside",
      depositCents: 4750,
      services: [{ name: "Maintenance Haircut", priceCents: 9500 }],
    });
    const view = await getOfferView(w.db, token, NOW, opts);
    expect(view).toMatchObject({
      timezone: "Australia/Melbourne",
      staffName: "Ryan",
      totalCents: 9500,
      bookingStatus: null,
      manageToken: null,
      resumable: false,
      policy: { version: "1" },
    });
  });

  test("reports expired once the window passes, before any sweep", async () => {
    const { token } = await offered();
    const later = new Date(NOW.getTime() + 21 * 60_000);
    expect((await getOfferByToken(w.db, token, later, opts))?.status).toBe("expired");
  });

  test("returns null for forged, malformed or unknown tokens", async () => {
    expect(await getOfferByToken(w.db, "garbage", NOW, opts)).toBeNull();
    expect(await getOfferByToken(w.db, `${w.staffId}.abc`, NOW, opts)).toBeNull();
    expect(
      await getOfferByToken(w.db, tokenFor("6f1c8d3e-1111-4222-8333-444455556666"), NOW, opts),
    ).toBeNull();
    expect(await getOfferByToken(w.db, tokenFor("not-a-uuid"), NOW, opts)).toBeNull();
  });

  test("a claimed offer exposes its booking and whether payment can resume", async () => {
    const { token } = await offered();
    await claim(token);
    const view = await getOfferView(w.db, token, NOW, opts);
    expect(view?.status).toBe("claimed");
    expect(view?.bookingStatus).toBe("pending_payment");
    expect(view?.resumable).toBe(true);
    expect(view?.manageToken).toBeTruthy();
  });
});

describe("claimOffer", () => {
  test("creates a held waitlist booking, marks the offer claimed and emits", async () => {
    const { offerId, token } = await offered();
    const hold = await claim(token);
    const [row] = await w.db.select().from(booking).where(eq(booking.id, hold.bookingId));

    expect(row).toMatchObject({
      status: "pending_payment",
      source: "waitlist",
      staffRequested: true,
      staffId: w.staffId,
    });
    expect(hold.depositCents).toBe(4750);
    const offer = await offerRow(w.db, offerId);
    expect(offer).toMatchObject({ status: "claimed", claimedBookingId: hold.bookingId });
    expect(await events(w.db, "waitlist.offer_claimed")).toEqual([
      { offerId, bookingId: hold.bookingId },
    ]);
  });

  test("the entry stays offered until the booking is confirmed", async () => {
    const { entryId, token } = await offered();
    await claim(token);
    expect((await entryRow(w.db, entryId)).status).toBe("offered");
  });

  test("claiming twice resumes the same hold", async () => {
    const { token } = await offered();
    const a = await claim(token);
    const b = await claim(token);
    expect(b.bookingId).toBe(a.bookingId);
    expect(b.depositCents).toBe(a.depositCents);
    expect(b.during).toEqual(a.during);
    expect(await events(w.db, "waitlist.offer_claimed")).toHaveLength(1);
  });

  test("a claim whose hold has lapsed is gone", async () => {
    const { token } = await offered();
    await claim(token);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    await expect(claim(token, later)).rejects.toMatchObject({ reason: "claimed" });
  });

  test("requires the current policy version", async () => {
    const { token } = await offered();
    await expect(claim(token, NOW, null)).rejects.toBeInstanceOf(ValidationError);
    await expect(claim(token, NOW, "0")).rejects.toBeInstanceOf(PolicyVersionError);
  });

  test("an expired offer cannot be claimed and is marked expired", async () => {
    const { offerId, token } = await offered();
    const later = new Date(NOW.getTime() + 25 * 60_000);
    await expect(claim(token, later)).rejects.toBeInstanceOf(OfferGoneError);
    expect((await offerRow(w.db, offerId)).status).toBe("expired");
    await expect(claim(token, later)).rejects.toMatchObject({ reason: "expired" });
  });

  test("a withdrawn offer cannot be claimed", async () => {
    const { offerId, token } = await offered();
    await w.db
      .update(waitlistOffer)
      .set({ status: "cancelled" })
      .where(eq(waitlistOffer.id, offerId));
    await expect(claim(token)).rejects.toMatchObject({ reason: "cancelled" });
  });

  test("a left entry cannot be claimed", async () => {
    const { entryId, token } = await offered();
    const { cancelWaitlistEntry } = await import("@/server/waitlist");
    await w.db.update(waitlistOffer).set({ status: "sent" });
    await cancelWaitlistEntry(w.db, entryId, "client");
    await w.db.update(waitlistOffer).set({ status: "sent" });
    await expect(claim(token)).rejects.toMatchObject({ reason: "cancelled" });
  });

  test("a slot someone else took yields a friendly SlotTakenError and slot_taken", async () => {
    const { offerId, token } = await offered();
    await bookedSlot(w);
    await expect(claim(token)).rejects.toBeInstanceOf(SlotTakenError);
    expect((await offerRow(w.db, offerId)).status).toBe("slot_taken");
    await expect(claim(token)).rejects.toBeInstanceOf(SlotTakenError);
  });

  test("bad tokens are not found", async () => {
    await expect(claim("nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(claim(tokenFor("6f1c8d3e-1111-4222-8333-444455556666"))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("when several people race for one slot exactly one wins", async () => {
    await setSettings(w.db, w.businessId, { waitlistMaxOffersPerSlot: 5 });
    const tokens: string[] = [];
    for (let n = 1; n <= 5; n += 1) tokens.push((await offered(n)).token);

    const results = await Promise.allSettled(tokens.map((t) => claim(t)));
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const r of lost) expect(r.reason).toBeInstanceOf(SlotTakenError);
    const offers = await w.db.select().from(waitlistOffer);
    expect(offers.filter((o) => o.status === "claimed")).toHaveLength(1);
    expect(offers.filter((o) => o.status === "slot_taken")).toHaveLength(4);
    expect(await w.db.select().from(booking)).toHaveLength(1);
  });

  test("uses ENCRYPTION_KEY from options for tokens", async () => {
    const { token } = await offered();
    await expect(
      claimOffer(w.db, token, NOW, {
        encryptionKey: Buffer.alloc(32, 1).toString("base64"),
        policyVersion: "1",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(KEY).toBeTruthy();
  });
});

describe("loadBillingDetails", () => {
  test("returns the payer's name, email and phone", async () => {
    const { token } = await offered();
    const hold = await claim(token);
    expect(await loadBillingDetails(w.db, hold.bookingId)).toEqual({
      name: "Person1 Waiting",
      email: "person1@example.com",
      phone: expect.stringMatching(/^\+61/),
    });
    await expect(
      loadBillingDetails(w.db, "6f1c8d3e-1111-4222-8333-444455556666"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
