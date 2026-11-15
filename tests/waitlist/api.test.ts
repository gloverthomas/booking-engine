import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { confirmBooking } from "@/server/booking";
import {
  createWaitlistLimiters,
  handleClaim,
  handleGetEntry,
  handleGetOffer,
  handleJoin,
  handleLeave,
  toWaitlistApiError,
  type WaitlistApiDeps,
} from "@/server/waitlist/api";
import { OfferGoneError, WaitlistDisabledError } from "@/server/waitlist";
import {
  BookingStateError,
  ClientBlockedError,
  NotFoundError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
} from "@/server/booking";
import { createWorld, setSettings, type World } from "../availability/setup";
import { NOW, bookedSlot, join, offerTo, opts, person, tokenFor } from "./setup";

let w: World;
let deps: WaitlistApiDeps;
const turnstile = vi.fn();
const intent = vi.fn();
const log = vi.fn();

beforeEach(async () => {
  w = await createWorld();
  turnstile.mockReset().mockResolvedValue({ ok: true });
  intent
    .mockReset()
    .mockResolvedValue({ paymentId: "pay_1", clientSecret: "cs_1", amountCents: 4750 });
  log.mockReset();
  deps = {
    db: w.db,
    now: () => NOW,
    log,
    limiters: createWaitlistLimiters(),
    trustedProxyHops: 1,
    verifyTurnstile: turnstile,
    tokenOptions: () => opts,
    createDepositIntent: intent,
    confirmBooking: (id, now) => confirmBooking(w.db, id, now),
  };
});
afterEach(async () => {
  await w.t.client.close();
});

const post = (body: unknown, ip = "1.1.1.1") =>
  new Request("http://x.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
const get = (ip = "1.1.1.1") =>
  new Request("http://x.test/api", { headers: { "x-forwarded-for": ip } });

const joinBody = (overrides: Record<string, unknown> = {}) => ({
  client: {
    firstName: "Sam",
    lastName: "Waiting",
    email: "Sam@Example.com",
    phone: "0412 345 678",
  },
  locationId: w.locationId,
  serviceIds: [w.haircutId],
  earliestDate: "2026-11-02",
  latestDate: "2026-11-06",
  timeOfDay: "morning",
  turnstileToken: "tok",
  ...overrides,
});

describe("POST /waitlist (join)", () => {
  test("joins and returns a leave token", async () => {
    const res = await handleJoin(deps, post(joinBody()));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.leaveToken).toContain(".");
    expect(turnstile).toHaveBeenCalledWith("tok", "1.1.1.1");

    const entry = await handleGetEntry(deps, get(), body.data.leaveToken);
    const view = await entry.json();
    expect(view.data).toMatchObject({
      status: "waiting",
      locationName: "Northside",
      serviceNames: ["Maintenance Haircut"],
      daysLabel: "Any day",
      timeLabel: "Mornings",
    });
  });

  test("validation failures return field errors", async () => {
    const res = await handleJoin(
      deps,
      post(joinBody({ client: { firstName: "", lastName: "x", email: "bad", phone: "1" } })),
    );
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(Object.keys(body.error.fieldErrors)).toEqual(
      expect.arrayContaining(["client.firstName", "client.email", "client.phone"]),
    );
  });

  test("rejects an inverted date range and non-json", async () => {
    expect((await handleJoin(deps, post(joinBody({ latestDate: "2026-11-01" })))).status).toBe(422);
    const bad = new Request("http://x.test", { method: "POST", body: "{nope" });
    expect((await handleJoin(deps, bad)).status).toBe(400);
  });

  test("domain errors become friendly responses", async () => {
    await setSettings(w.db, w.businessId, { waitlistEnabled: false });
    const res = await handleJoin(deps, post(joinBody()));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("waitlist_disabled");
  });

  test("maps a server-side validation failure onto client fields", async () => {
    const res = await handleJoin(
      deps,
      post(joinBody({ serviceIds: ["6f1c8d3e-1111-4222-8333-444455556666"] })),
    );
    expect(res.status).toBe(422);
  });

  test.each([
    ["missing_token", 400, "captcha_failed"],
    ["rejected", 400, "captcha_failed"],
    ["unreachable", 503, "service_unavailable"],
  ])("turnstile %s", async (reason, status, code) => {
    turnstile.mockResolvedValue({ ok: false, reason });
    const res = await handleJoin(deps, post(joinBody()));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });

  test("rate limits by IP", async () => {
    for (let i = 0; i < 6; i += 1) await handleJoin(deps, post(joinBody(), "9.9.9.9"));
    const res = await handleJoin(deps, post(joinBody(), "9.9.9.9"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect((await handleJoin(deps, post(joinBody(), "8.8.8.8"))).status).toBe(201);
  });
});

async function offered() {
  const { entryId } = await join(w, { client: person(1) });
  const { offerId } = await offerTo(w, entryId);
  return { entryId, offerId, token: tokenFor(offerId) };
}

describe("offers", () => {
  test("GET returns the offer, time and money", async () => {
    const { token, offerId } = await offered();
    const res = await handleGetOffer(deps, get(), token);
    const { data } = await res.json();
    expect(data).toMatchObject({
      offerId,
      status: "sent",
      depositCents: 4750,
      totalCents: 9500,
      staffName: "Ryan",
      timezone: "Australia/Melbourne",
      serverNow: NOW.toISOString(),
      policy: { version: "1" },
    });
  });

  test("GET 404s for a bad link and 422s for a too-short token", async () => {
    expect(
      (await handleGetOffer(deps, get(), tokenFor("6f1c8d3e-1111-4222-8333-444455556666"))).status,
    ).toBe(404);
    expect((await handleGetOffer(deps, get(), "x")).status).toBe(422);
  });

  test("claim starts the deposit payment and returns billing details", async () => {
    const { token } = await offered();
    const res = await handleClaim(deps, post({ policyVersion: "1", policyAccepted: true }), token);
    const { data } = await res.json();
    expect(res.status).toBe(201);
    expect(data).toMatchObject({
      confirmed: false,
      depositCents: 4750,
      payment: { clientSecret: "cs_1", amountCents: 4750 },
      billing: { name: "Person1 Waiting", email: "person1@example.com" },
    });
    expect(intent).toHaveBeenCalledWith(data.bookingId);

    // Claiming again resumes the same hold.
    const again = await handleClaim(
      deps,
      post({ policyVersion: "1", policyAccepted: true }),
      token,
    );
    expect((await again.json()).data.bookingId).toBe(data.bookingId);
  });

  test("a free booking is confirmed straight away", async () => {
    await setSettings(w.db, w.businessId, { depositPct: 0 });
    const { token } = await offered();
    const res = await handleClaim(deps, post({ policyVersion: "1", policyAccepted: true }), token);
    const { data } = await res.json();
    expect(data).toMatchObject({ confirmed: true, payment: null });
    expect(intent).not.toHaveBeenCalled();
  });

  test("requires the policy tick", async () => {
    const { token } = await offered();
    const res = await handleClaim(deps, post({ policyVersion: "1", policyAccepted: false }), token);
    expect(res.status).toBe(422);
  });

  test("a changed policy is a 409", async () => {
    const { token } = await offered();
    const res = await handleClaim(deps, post({ policyVersion: "0", policyAccepted: true }), token);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("policy_changed");
  });

  test("an expired offer is 410 with a reason", async () => {
    const { token } = await offered();
    deps = { ...deps, now: () => new Date(NOW.getTime() + 30 * 60_000) };
    const res = await handleClaim(deps, post({ policyVersion: "1", policyAccepted: true }), token);
    expect(res.status).toBe(410);
    expect((await res.json()).error.fieldErrors.reason).toBe("expired");
  });

  test("a taken slot is a 409 slot_taken", async () => {
    const { token } = await offered();
    await bookedSlot(w);
    const res = await handleClaim(deps, post({ policyVersion: "1", policyAccepted: true }), token);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("slot_taken");
  });

  test("a payment start failure keeps the hold so a retry resumes", async () => {
    const { token } = await offered();
    intent.mockRejectedValueOnce(new Error("stripe down"));
    const first = await handleClaim(
      deps,
      post({ policyVersion: "1", policyAccepted: true }),
      token,
    );
    expect(first.status).toBe(502);
    const retry = await handleClaim(
      deps,
      post({ policyVersion: "1", policyAccepted: true }),
      token,
    );
    expect(retry.status).toBe(201);
  });
});

describe("leave", () => {
  test("leaves, idempotently, and reports unknown links", async () => {
    const { entryId } = await join(w);
    const token = tokenFor(entryId);
    expect((await handleLeave(deps, post({}), token)).status).toBe(200);
    expect((await handleLeave(deps, post({}), token)).status).toBe(200);
    const view = await (await handleGetEntry(deps, get(), token)).json();
    expect(view.data.status).toBe("cancelled");
    expect(
      (await handleLeave(deps, post({}), tokenFor("6f1c8d3e-1111-4222-8333-444455556666"))).status,
    ).toBe(404);
    expect(
      (await handleGetEntry(deps, get(), tokenFor("6f1c8d3e-1111-4222-8333-444455556666"))).status,
    ).toBe(404);
  });
});

describe("toWaitlistApiError", () => {
  test.each([
    [new OfferGoneError("expired"), 410],
    [new SlotTakenError(), 409],
    [new PolicyVersionError("1", "0"), 409],
    [new NotFoundError("x"), 404],
    [new WaitlistDisabledError(), 409],
    [new ClientBlockedError(), 403],
    [new BookingStateError("x"), 409],
    [new ValidationError("bad", ["phone: Enter a valid mobile number"]), 422],
  ])("%s", (error, status) => {
    expect(toWaitlistApiError(error)?.status).toBe(status);
  });

  test("unexpected errors are not mapped", () => {
    expect(toWaitlistApiError(new Error("boom"))).toBeNull();
  });

  test("validation issues keep client prefixes", () => {
    const mapped = toWaitlistApiError(
      new ValidationError("bad", ["phone: Enter a valid mobile number", "weekdays.0: too big"]),
    );
    expect(mapped?.fieldErrors).toEqual({
      "client.phone": "Enter a valid mobile number",
      "weekdays.0": "too big",
    });
  });
});
