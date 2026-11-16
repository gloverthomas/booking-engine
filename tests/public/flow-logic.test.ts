import { describe, expect, it, vi } from "vitest";
import {
  WEEKDAY_LABELS,
  buildMonthGrid,
  canGoNextMonth,
  canGoPrevMonth,
  firstAvailable,
} from "@/components/public/flow/calendar";
import {
  URGENT_BELOW_MS,
  formatCountdown,
  makeHoldClock,
  remainingFraction,
  remainingMs,
} from "@/components/public/flow/countdown";
import {
  EMPTY_DETAILS,
  applyRemembered,
  buildHoldRequest,
  toRemembered,
  validateDetails,
} from "@/components/public/flow/details";
import {
  EMBED_SOURCE,
  isEmbedded,
  postEmbedMessage,
  resizeMessage,
} from "@/components/public/flow/embed";
import {
  REMEMBERED_KEY,
  forgetRememberedClient,
  loadRememberedClient,
  saveRememberedClient,
} from "@/components/public/flow/remembered-client";
import {
  canLeaveStep,
  canVisit,
  flowReducer,
  flowTotals,
  initialState,
  initialStateFor,
  selectedLocation,
  selectedServices,
  stepsFor,
} from "@/components/public/flow/state";
import { createApiClient } from "@/components/public/flow/api-client";
import type { HoldData } from "@/lib/public-api-types";
import { catalog, LOC, SVC_BEARD, SVC_CUT } from "./fakes";

describe("buildMonthGrid", () => {
  const input = {
    month: "2026-11-14",
    availableDates: new Set(["2026-11-14", "2026-11-20", "2026-11-13", "2027-03-01"]),
    today: "2026-11-14",
    maxDate: "2027-02-12",
  };

  it("pads to Monday-first weeks of seven", () => {
    const weeks = buildMonthGrid(input);
    expect(WEEKDAY_LABELS[0]).toBe("Mon");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 1 Nov 2026 is a Sunday, so six empty cells precede it.
    expect(weeks[0].slice(0, 6).every((c) => c === null)).toBe(true);
    expect(weeks[0][6]?.date).toBe("2026-11-01");
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
  });

  it("marks availability, today, and disables the past and beyond the horizon", () => {
    const cells = Object.fromEntries(
      buildMonthGrid(input)
        .flat()
        .flatMap((c) => (c ? [[c.date, c]] : [])),
    );
    expect(cells["2026-11-20"]).toMatchObject({ available: true, disabled: false, day: 20 });
    expect(cells["2026-11-14"]).toMatchObject({ isToday: true, available: true });
    expect(cells["2026-11-13"]).toMatchObject({ available: false, disabled: true });
    expect(cells["2026-11-21"]).toMatchObject({ available: false, disabled: true });
    const march = buildMonthGrid({ ...input, month: "2027-03-01" }).flat();
    expect(march.find((c) => c?.date === "2027-03-01")).toMatchObject({ disabled: true });
  });

  it("limits month navigation to the bookable window", () => {
    expect(canGoPrevMonth("2026-11-01", "2026-11-14")).toBe(false);
    expect(canGoPrevMonth("2026-12-01", "2026-11-14")).toBe(true);
    expect(canGoNextMonth("2026-12-01", "2027-02-12")).toBe(true);
    expect(canGoNextMonth("2027-02-01", "2027-02-12")).toBe(false);
  });

  it("finds the first available date", () => {
    expect(firstAvailable(["2026-11-20", "2026-11-16", "2026-11-01"], "2026-11-14")).toBe(
      "2026-11-16",
    );
    expect(firstAvailable([], "2026-11-14")).toBeNull();
  });
});

describe("hold countdown", () => {
  const clock = makeHoldClock("2026-11-14T00:10:00Z", "2026-11-14T00:00:00Z", 1_000_000);

  it("counts down from elapsed client time, ignoring client clock skew", () => {
    expect(remainingMs(clock, 1_000_000)).toBe(600_000);
    expect(remainingMs(clock, 1_000_000 + 90_000)).toBe(510_000);
    expect(remainingMs(clock, 1_000_000 + 700_000)).toBe(0);
    expect(remainingMs(clock, 5)).toBe(600_000); // client clock went backwards
  });

  it("formats and reports the remaining fraction", () => {
    expect(formatCountdown(582_100)).toBe("9:43");
    expect(formatCountdown(59_000)).toBe("0:59");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(remainingFraction(clock, 1_000_000 + 300_000)).toBeCloseTo(0.5);
    expect(remainingFraction({ ...clock, expiresAtMs: clock.serverNowMs }, 1_000_000)).toBe(0);
    expect(URGENT_BELOW_MS).toBe(60_000);
  });
});

describe("remembered client", () => {
  const memory = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  };
  const client = {
    firstName: "Sam",
    lastName: "Client",
    email: "sam@example.com",
    phone: "0410123456",
  };

  it("round-trips and forgets", () => {
    const storage = memory();
    expect(loadRememberedClient(storage)).toBeNull();
    saveRememberedClient(client, storage);
    expect(loadRememberedClient(storage)).toEqual(client);
    forgetRememberedClient(storage);
    expect(loadRememberedClient(storage)).toBeNull();
  });

  it("ignores junk, tolerates broken storage and missing storage", () => {
    const storage = memory();
    storage.setItem(REMEMBERED_KEY, "not json");
    expect(loadRememberedClient(storage)).toBeNull();
    storage.setItem(REMEMBERED_KEY, "42");
    expect(loadRememberedClient(storage)).toBeNull();
    storage.setItem(REMEMBERED_KEY, JSON.stringify({ firstName: 5, phone: "x" }));
    expect(loadRememberedClient(storage)).toBeNull();

    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadRememberedClient(broken)).toBeNull();
    expect(() => saveRememberedClient(client, broken)).not.toThrow();
    expect(() => forgetRememberedClient(broken)).not.toThrow();
    expect(loadRememberedClient(null)).toBeNull();
    expect(() => saveRememberedClient(client, null)).not.toThrow();
    expect(() => forgetRememberedClient(null)).not.toThrow();
  });

  it("never carries consent into the form", () => {
    const filled = applyRemembered(EMPTY_DETAILS, client);
    expect(filled.firstName).toBe("Sam");
    expect(filled.marketingOptIn).toBe(false);
    expect(filled.policyAccepted).toBe(false);
    expect(Object.keys(toRemembered({ ...filled, marketingOptIn: true }))).not.toContain(
      "marketingOptIn",
    );
  });
});

describe("validateDetails and buildHoldRequest", () => {
  const services = catalog.locations[0].services;
  const good = {
    ...EMPTY_DETAILS,
    firstName: " Sam ",
    lastName: "Client",
    email: "sam@example.com",
    phone: "0410 123 456",
    policyAccepted: true,
    intakeAnswers: { q1: "Short", q2: "  " },
  };

  it("passes good details", () => {
    expect(validateDetails(good, services)).toEqual({});
  });

  it("flags every missing or malformed field with the server's keys", () => {
    const errors = validateDetails(EMPTY_DETAILS, services);
    expect(Object.keys(errors).sort()).toEqual([
      "client.email",
      "client.firstName",
      "client.lastName",
      "client.phone",
      "intakeAnswers.q1",
      "policyAccepted",
    ]);
    const bad = validateDetails(
      { ...good, email: "nope", phone: "12", intakeAnswers: { q1: "x" } },
      services,
    );
    expect(bad["client.email"]).toBe("Enter a valid email address");
    expect(bad["client.phone"]).toBe("Enter a valid mobile number");
  });

  it("builds a clean hold request without empty optionals", () => {
    const req = buildHoldRequest({
      locationId: LOC,
      serviceIds: [SVC_CUT],
      slotStart: "2026-11-20T03:30:00.000Z",
      details: { ...good, comments: "  hi  ", marketingOptIn: true },
      policyVersion: "1",
      turnstileToken: "tok",
    });
    expect(req).toMatchObject({
      locationId: LOC,
      serviceIds: [SVC_CUT],
      start: "2026-11-20T03:30:00.000Z",
      client: { firstName: "Sam", email: "sam@example.com", marketingOptIn: true },
      comments: "hi",
      intakeAnswers: { q1: "Short" },
      policyVersion: "1",
      policyAccepted: true,
      turnstileToken: "tok",
    });
    expect(req.client).not.toHaveProperty("pronouns");
    expect(req).not.toHaveProperty("otherPhone");
    expect(req).not.toHaveProperty("company");
  });
});

describe("flow reducer", () => {
  const slot = { start: "2026-11-20T03:30:00Z", end: "2026-11-20T04:15:00Z", label: "2:30 pm" };
  const hold: HoldData = {
    bookingId: "b",
    manageToken: "t",
    holdExpiresAt: "2026-11-14T00:10:00Z",
    serverNow: "2026-11-14T00:00:00Z",
    totalCents: 9500,
    depositCents: 4750,
    start: slot.start,
    end: slot.end,
    confirmed: false,
    payment: { clientSecret: "s", paymentId: "p", amountCents: 4750 },
  };
  const run = (...actions: Parameters<typeof flowReducer>[1][]) =>
    actions.reduce(flowReducer, initialStateFor(catalog));

  it("skips the location step for a single location and shows it for several", () => {
    expect(initialStateFor(catalog)).toMatchObject({ step: "services", locationId: LOC });
    const two = {
      ...catalog,
      locations: [catalog.locations[0], { ...catalog.locations[0], id: "x" }],
    };
    expect(initialStateFor(two)).toMatchObject({ step: "location", locationId: null });
    expect(initialState().step).toBe("services");
  });

  it("selecting a different location resets the dependent choices", () => {
    const state = run(
      { type: "toggleService", serviceId: SVC_CUT },
      { type: "pickSlot", slot },
      { type: "selectLocation", locationId: "other" },
    );
    expect(state).toMatchObject({
      locationId: "other",
      serviceIds: [],
      slot: null,
    });
    const same = run(
      { type: "toggleService", serviceId: SVC_CUT },
      { type: "selectLocation", locationId: LOC },
    );
    expect(same.serviceIds).toEqual([SVC_CUT]);
  });

  it("toggling services clears the date and slot", () => {
    const state = run(
      { type: "toggleService", serviceId: SVC_CUT },
      { type: "pickDate", date: "2026-11-20" },
      { type: "pickSlot", slot },
      { type: "toggleService", serviceId: SVC_BEARD },
    );
    expect(state).toMatchObject({ serviceIds: [SVC_CUT, SVC_BEARD], date: null, slot: null });
    expect(flowReducer(state, { type: "toggleService", serviceId: SVC_CUT }).serviceIds).toEqual([
      SVC_BEARD,
    ]);
  });

  it("picking a date clears the slot and editing merges details", () => {
    const state = run(
      { type: "pickSlot", slot },
      { type: "pickDate", date: "2026-11-21" },
      { type: "editDetails", patch: { firstName: "Sam" } },
      { type: "editDetails", patch: { lastName: "C" } },
    );
    expect(state.slot).toBeNull();
    expect(state.details).toMatchObject({ firstName: "Sam", lastName: "C" });
  });

  it("moves to pay on a hold, and back to time when the slot is lost", () => {
    const paying = run({ type: "holdCreated", hold });
    expect(paying).toMatchObject({ step: "pay", hold });
    const lost = flowReducer(paying, { type: "slotLost", notice: "taken" });
    expect(lost).toMatchObject({ step: "time", hold: null, slot: null, notice: "taken" });
  });

  it("releasing a hold can return to details keeping the chosen time", () => {
    const state = run(
      { type: "pickSlot", slot },
      { type: "holdCreated", hold },
      { type: "holdReleased", to: "details" },
    );
    expect(state).toMatchObject({ step: "details", hold: null, slot });
    const toTime = flowReducer(state, { type: "holdReleased", notice: "expired" });
    expect(toTime).toMatchObject({ step: "time", slot: null, notice: "expired" });
  });

  it("manages notices and navigation", () => {
    let state = run({ type: "notice", notice: "hello" });
    expect(state.notice).toBe("hello");
    state = flowReducer(state, { type: "goTo", step: "details" });
    expect(state).toMatchObject({ step: "details", notice: null });
  });

  it("derives selections, totals and steps", () => {
    const state = run(
      { type: "toggleService", serviceId: SVC_BEARD },
      { type: "toggleService", serviceId: SVC_CUT },
    );
    expect(selectedLocation(state, catalog)?.name).toBe("Northside");
    expect(selectedServices(state, catalog).map((s) => s.id)).toEqual([SVC_BEARD, SVC_CUT]);
    expect(flowTotals(state, catalog)).toEqual({
      totalCents: 12500,
      durationMin: 60,
      depositCents: 6250,
    });
    expect(stepsFor(catalog, state)).toEqual(["services", "time", "details", "pay"]);
    expect(selectedServices(initialState(), catalog)).toEqual([]);

    const freeCatalog = {
      ...catalog,
      locations: [
        {
          ...catalog.locations[0],
          services: catalog.locations[0].services.map((s) => ({ ...s, depositPct: 0 })),
        },
      ],
    };
    expect(stepsFor(freeCatalog, state)).toEqual(["services", "time", "details"]);
    const multi = {
      ...catalog,
      locations: [catalog.locations[0], { ...catalog.locations[0], id: "y" }],
    };
    expect(stepsFor(multi, state)[0]).toBe("location");
  });

  it("gates navigation on prerequisites", () => {
    const steps = ["services", "time", "details", "pay"] as const;
    const empty = initialStateFor(catalog);
    expect(canLeaveStep(initialState(), "location")).toBe(false);
    expect(canLeaveStep(empty, "location")).toBe(true);
    expect(canLeaveStep(empty, "services")).toBe(false);
    expect(canLeaveStep(empty, "time")).toBe(false);
    expect(canLeaveStep(empty, "details")).toBe(true);
    expect(canVisit(empty, steps, "time")).toBe(false);

    const ready = run(
      { type: "toggleService", serviceId: SVC_CUT },
      { type: "pickSlot", slot },
      { type: "goTo", step: "details" },
    );
    expect(canVisit(ready, steps, "services")).toBe(true);
    expect(canVisit(ready, steps, "time")).toBe(true);
    expect(canVisit(ready, steps, "pay")).toBe(false);
    expect(canVisit(flowReducer(ready, { type: "holdCreated", hold }), steps, "pay")).toBe(true);
    expect(canVisit(ready, steps, "location")).toBe(false);
  });
});

describe("embed messaging", () => {
  it("detects framing, including cross-origin access errors", () => {
    expect(isEmbedded({ self: 1, top: 1 })).toBe(false);
    expect(isEmbedded({ self: 1, top: 2 })).toBe(true);
    const hostile = {
      self: 1,
      get top(): never {
        throw new Error("cross-origin");
      },
    };
    expect(isEmbedded(hostile)).toBe(true);
  });

  it("posts the protocol message", () => {
    const parent = { postMessage: vi.fn() };
    postEmbedMessage(parent, resizeMessage(812.2));
    expect(parent.postMessage).toHaveBeenCalledWith(
      { source: EMBED_SOURCE, type: "resize", height: 813 },
      "*",
    );
  });
});

describe("api client", () => {
  const client = (fetchImpl: typeof fetch) => createApiClient(fetchImpl, "/api/public");
  const respond = (body: unknown, status = 200) =>
    (() =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

  it("unwraps successful envelopes", async () => {
    const result = await client(
      respond({ success: true, data: { today: "2026-11-14" } }),
    ).catalog();
    expect(result).toEqual({ ok: true, data: { today: "2026-11-14" } });
  });

  it("returns API errors with their status", async () => {
    const result = await client(
      respond({ success: false, error: { code: "slot_taken", message: "Taken" } }, 409),
    ).catalog();
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: { code: "slot_taken", message: "Taken" },
    });
  });

  it("survives network failures and garbage", async () => {
    const down = await client((() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch).catalog();
    expect(down).toMatchObject({ ok: false, status: 0, error: { code: "network" } });

    const html = await client((() =>
      Promise.resolve(
        new Response("<html>", { status: 502 }),
      )) as unknown as typeof fetch).catalog();
    expect(html).toMatchObject({ ok: false, status: 502, error: { code: "bad_response" } });

    const odd = await client(respond({ hello: "world" })).catalog();
    expect(odd).toMatchObject({ ok: false, error: { code: "bad_response" } });
    const oddError = await client(respond({ success: false, error: "x" }, 400)).catalog();
    expect(oddError).toMatchObject({ ok: false, error: { code: "bad_response" } });
  });

  it("builds the right requests", async () => {
    const fetchImpl = vi.fn(respond({ success: true, data: {} }));
    const api = client(fetchImpl as unknown as typeof fetch);

    await api.availability({
      locationId: LOC,
      serviceIds: [SVC_CUT, SVC_BEARD],
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `/api/public/availability?locationId=${LOC}&serviceIds=${SVC_CUT}%2C${SVC_BEARD}&fromDate=2026-11-01&toDate=2026-11-30`,
    );

    await api.cancel("a.b/c", "moving");
    const [cancelUrl, cancelInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(cancelUrl).toBe("/api/public/bookings/a.b%2Fc/cancel");
    expect(cancelInit).toMatchObject({ method: "POST", body: '{"reason":"moving"}' });

    await api.reschedule("tok", "2026-11-21T03:30:00Z");
    expect((fetchImpl.mock.calls[2] as [string, RequestInit])[1].body).toBe(
      '{"start":"2026-11-21T03:30:00Z"}',
    );
    await api.booking("tok");
    expect(fetchImpl.mock.calls[3][0]).toBe("/api/public/bookings/tok");
    await api.createHold({} as never);
    expect(fetchImpl.mock.calls[4][0]).toBe("/api/public/holds");
    expect(api.icsUrl("tok")).toBe("/api/public/bookings/tok/ics");
  });
});
