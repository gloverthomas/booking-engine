import { describe, expect, it, vi } from "vitest";
import {
  composeComments,
  handleAvailability,
  handleCatalog,
  handleCreateHold,
  resolveSelection,
} from "@/lib/public-api-handlers";
import {
  BOOKING_ID,
  LOC,
  NOW,
  SVC_BEARD,
  SVC_CUT,
  catalog,
  get,
  makeBackend,
  makeDeps,
  post,
  validHoldBody,
} from "./fakes";

async function json(res: Response) {
  return (await res.json()) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; fieldErrors?: Record<string, string> };
  };
}

describe("GET /catalog", () => {
  it("returns the catalog in the envelope", async () => {
    const res = await handleCatalog(makeDeps(), get("http://localhost/api/public/catalog"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect((body.data as { locations: unknown[] }).locations).toHaveLength(1);
  });

  it("is rate limited per ip", async () => {
    const deps = makeDeps();
    let last = 200;
    for (let i = 0; i < 125; i++) {
      last = (await handleCatalog(deps, get("http://localhost/c"))).status;
    }
    expect(last).toBe(429);
    const blocked = await handleCatalog(deps, get("http://localhost/c"));
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await json(blocked)).error?.code).toBe("rate_limited");
  });

  it("never leaks internal errors", async () => {
    const deps = makeDeps({
      loadBusiness: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
      },
    });
    const res = await handleCatalog(deps, get("http://localhost/c"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain("hunter2");
  });
});

describe("resolveSelection", () => {
  it("returns services in request order and dedupes", () => {
    const { services } = resolveSelection(catalog.locations, LOC, [SVC_BEARD, SVC_CUT, SVC_BEARD]);
    expect(services.map((s) => s.id)).toEqual([SVC_BEARD, SVC_CUT]);
  });
  it("rejects unknown locations and services", () => {
    expect(() => resolveSelection(catalog.locations, "x", [SVC_CUT])).toThrowError(
      /location isn't available/,
    );
    expect(() => resolveSelection(catalog.locations, LOC, ["nope"])).toThrowError(
      /isn't available at this location/,
    );
  });
});

describe("GET /availability", () => {
  const url = (extra = "") =>
    `http://localhost/api/public/availability?locationId=${LOC}&serviceIds=${SVC_CUT}&fromDate=2026-11-01&toDate=2026-11-30${extra}`;

  it("groups slots by local day and clamps to today", async () => {
    const backend = makeBackend({
      getAvailableSlots: vi.fn(async () => [
        {
          staffId: "s1",
          start: new Date("2026-11-20T03:30:00Z"),
          end: new Date("2026-11-20T04:15:00Z"),
        },
      ]),
    });
    const res = await handleAvailability(makeDeps({ backend }), get(url()));
    const body = await json(res);
    expect(res.status).toBe(200);
    const data = body.data as {
      days: Array<{ date: string; afternoon: unknown[] }>;
      fromDate: string;
    };
    expect(data.fromDate).toBe("2026-11-14");
    expect(data.days).toEqual([
      expect.objectContaining({ date: "2026-11-20", afternoon: [expect.anything()] }),
    ]);
    expect(backend.getAvailableSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: LOC,
        serviceIds: [SVC_CUT],
        fromDate: "2026-11-14",
        toDate: "2026-11-30",
        now: NOW,
      }),
    );
  });

  it("returns empty without calling the backend when wholly in the past or too far ahead", async () => {
    const backend = makeBackend();
    const past = await handleAvailability(
      makeDeps({ backend }),
      get(url().replace("2026-11-01", "2026-10-01").replace("2026-11-30", "2026-10-30")),
    );
    expect((await json(past)).data).toMatchObject({ days: [] });
    const far = await handleAvailability(
      makeDeps({ backend }),
      get(url().replace("2026-11-01", "2027-06-01").replace("2026-11-30", "2027-06-30")),
    );
    expect((await json(far)).data).toMatchObject({ days: [] });
    expect(backend.getAvailableSlots).not.toHaveBeenCalled();
  });

  it("validates input", async () => {
    const res = await handleAvailability(
      makeDeps(),
      get("http://localhost/api/public/availability?locationId=x"),
    );
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe("validation_failed");
  });

  it("rejects services that are not bookable at the location", async () => {
    const other = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const res = await handleAvailability(makeDeps(), get(url().replace(SVC_CUT, other)));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe("invalid_selection");
  });
});

describe("composeComments", () => {
  it("joins comments, other phone and company", () => {
    expect(composeComments({ comments: "Hi", otherPhone: "+61391234567", company: "Acme" })).toBe(
      "Hi\nOther phone: +61391234567\nCompany: Acme",
    );
    expect(composeComments({})).toBeUndefined();
  });
});

describe("POST /holds", () => {
  it("creates a hold and returns a payment intent when a deposit is due", async () => {
    const backend = makeBackend();
    const deps = makeDeps({ backend });
    const res = await handleCreateHold(deps, post(validHoldBody));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data).toMatchObject({
      bookingId: BOOKING_ID,
      depositCents: 4750,
      totalCents: 9500,
      confirmed: false,
      serverNow: NOW.toISOString(),
      holdExpiresAt: "2026-11-14T00:10:00.000Z",
      payment: { clientSecret: "pi_secret", paymentId: "pay_1", amountCents: 4750 },
    });

    expect(backend.createHold).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: LOC,
        serviceIds: [SVC_CUT],
        start: new Date("2026-11-20T03:30:00.000Z"),
        client: expect.objectContaining({ email: "sam@example.com", phone: "+61410123456" }),
        comments: "Running late maybe\nOther phone: +61391234567\nCompany: Acme",
        intakeAnswers: { q1: "Short" },
        policyVersion: "1",
        source: "online",
      }),
    );
    expect(backend.confirmBooking).not.toHaveBeenCalled();
  });

  it("confirms immediately when no deposit is due", async () => {
    const base = makeBackend();
    const backend = makeBackend({
      createHold: vi.fn(async () => ({
        ...(await base.createHold({} as never)),
        depositCents: 0,
      })),
    });
    const res = await handleCreateHold(makeDeps({ backend }), post(validHoldBody));
    const body = await json(res);
    expect(body.data).toMatchObject({ confirmed: true, payment: null });
    expect(backend.confirmBooking).toHaveBeenCalledWith(BOOKING_ID, NOW);
    expect(backend.createDepositIntent).not.toHaveBeenCalled();
  });

  it("verifies Turnstile with the caller's ip and rejects failures before any work", async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: "rejected" as const }));
    const backend = makeBackend();
    const res = await handleCreateHold(
      makeDeps({ backend, verifyTurnstile: verify }),
      post(validHoldBody, { "x-forwarded-for": "9.9.9.9, 5.6.7.8" }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("captcha_failed");
    expect(verify).toHaveBeenCalledWith("tok", "5.6.7.8");
    expect(backend.createHold).not.toHaveBeenCalled();
  });

  it("returns 503 when the captcha is unavailable or unconfigured", async () => {
    const deps = makeDeps({
      verifyTurnstile: async () => ({ ok: false, reason: "not_configured" }),
    });
    const res = await handleCreateHold(deps, post(validHoldBody));
    expect(res.status).toBe(503);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "turnstile_unavailable" }),
    );
  });

  it("returns field errors for bad details", async () => {
    const res = await handleCreateHold(
      makeDeps(),
      post({
        ...validHoldBody,
        client: { ...validHoldBody.client, email: "nope" },
        policyAccepted: false,
      }),
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error?.fieldErrors).toMatchObject({
      "client.email": "Enter a valid email address",
      policyAccepted: expect.stringContaining("cancellation policy"),
    });
  });

  it("rejects malformed JSON", async () => {
    const res = await handleCreateHold(makeDeps(), post("{not json"));
    expect(res.status).toBe(400);
  });

  it("asks the client to re-read a changed policy", async () => {
    const res = await handleCreateHold(makeDeps(), post({ ...validHoldBody, policyVersion: "0" }));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("policy_changed");
  });

  it("requires answers to required intake questions", async () => {
    const res = await handleCreateHold(makeDeps(), post({ ...validHoldBody, intakeAnswers: {} }));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.fieldErrors).toEqual({
      "intakeAnswers.q1": "Please answer: Hair length?",
    });
  });

  it("rejects unavailable services and past start times", async () => {
    const bad = await handleCreateHold(
      makeDeps(),
      post({ ...validHoldBody, serviceIds: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"] }),
    );
    expect((await json(bad)).error?.code).toBe("invalid_selection");

    const past = await handleCreateHold(
      makeDeps(),
      post({ ...validHoldBody, start: "2026-11-13T03:30:00Z" }),
    );
    expect(past.status).toBe(409);
    expect((await json(past)).error?.code).toBe("slot_taken");
  });

  it("maps a lost race to slot_taken", async () => {
    const backend = makeBackend({
      createHold: vi.fn(async () => {
        throw Object.assign(new Error("exclusion violation"), { code: "23P01" });
      }),
    });
    const res = await handleCreateHold(makeDeps({ backend }), post(validHoldBody));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("slot_taken");
  });

  it("hides unknown backend failures", async () => {
    const backend = makeBackend({
      createHold: vi.fn(async () => {
        throw new Error("boom with secrets");
      }),
    });
    const res = await handleCreateHold(makeDeps({ backend }), post(validHoldBody));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain("secrets");
  });

  it("releases the hold when the payment cannot be started", async () => {
    const backend = makeBackend({
      createDepositIntent: vi.fn(async () => {
        throw new Error("stripe down");
      }),
    });
    const res = await handleCreateHold(makeDeps({ backend }), post(validHoldBody));
    expect(res.status).toBe(502);
    expect((await json(res)).error?.code).toBe("payment_unavailable");
    expect(backend.cancelBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID, by: "client" }),
    );
  });

  it("still reports a clean error when releasing the hold also fails", async () => {
    const backend = makeBackend({
      createDepositIntent: vi.fn(async () => {
        throw new Error("stripe down");
      }),
      cancelBooking: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const deps = makeDeps({ backend });
    const res = await handleCreateHold(deps, post(validHoldBody));
    expect(res.status).toBe(502);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "hold_release_failed" }),
    );
  });

  it("limits hold creation per ip", async () => {
    const deps = makeDeps();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await handleCreateHold(deps, post(validHoldBody))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
