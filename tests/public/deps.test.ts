import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeDb = { tag: "db" };
const env: Record<string, string | undefined> = { NODE_ENV: "test" };

vi.mock("@/lib/env", () => ({ getEnv: () => env }));

vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/server/availability", () => ({ getAvailableSlots: vi.fn(async () => ["slot"]) }));
vi.mock("@/server/booking", () => ({
  createHold: vi.fn(async () => "hold"),
  confirmBooking: vi.fn(async () => undefined),
  getBookingByToken: vi.fn(async () => null),
  cancelBooking: vi.fn(async () => "cancel"),
  rescheduleBooking: vi.fn(async () => undefined),
}));
vi.mock("@/server/payments", () => ({ createDepositIntent: vi.fn(async () => "intent") }));
vi.mock("@/lib/public-api-catalog", () => ({
  loadBusiness: vi.fn(async () => "business"),
  loadCatalog: vi.fn(async () => "catalog"),
  loadBookingContext: vi.fn(async () => "context"),
}));

import { getPublicApiDeps } from "@/lib/public-api-deps";
import * as availability from "@/server/availability";
import * as bookingModule from "@/server/booking";
import * as payments from "@/server/payments";
import * as catalogModule from "@/lib/public-api-catalog";
import { makeManageToken } from "@/server/manage-token";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("getPublicApiDeps", () => {
  beforeEach(() => {
    for (const key of Object.keys(env)) delete env[key];
    env.NODE_ENV = "test";
  });

  it("binds the database into every backend function", async () => {
    const deps = getPublicApiDeps();
    const now = new Date();

    await deps.backend.getAvailableSlots({} as never);
    await deps.backend.createHold({} as never);
    await deps.backend.confirmBooking("b1", now);
    await deps.backend.createDepositIntent("b1");
    await deps.backend.getBookingByToken("t");
    await deps.backend.cancelBooking({} as never);
    await deps.backend.rescheduleBooking({} as never);
    await deps.loadBusiness();
    await deps.loadCatalog({} as never, now);
    await deps.loadBookingContext("b1");

    expect(availability.getAvailableSlots).toHaveBeenCalledWith(fakeDb, {});
    expect(bookingModule.createHold).toHaveBeenCalledWith(fakeDb, {});
    expect(bookingModule.confirmBooking).toHaveBeenCalledWith(fakeDb, "b1", now);
    expect(payments.createDepositIntent).toHaveBeenCalledWith(fakeDb, "b1");
    expect(bookingModule.getBookingByToken).toHaveBeenCalledWith(fakeDb, "t");
    expect(bookingModule.cancelBooking).toHaveBeenCalledWith(fakeDb, {});
    expect(bookingModule.rescheduleBooking).toHaveBeenCalledWith(fakeDb, {});
    expect(catalogModule.loadBusiness).toHaveBeenCalledWith(fakeDb);
    expect(catalogModule.loadCatalog).toHaveBeenCalledWith(fakeDb, {}, now);
    expect(catalogModule.loadBookingContext).toHaveBeenCalledWith(fakeDb, "b1");
  });

  it("shares limiter state across calls", () => {
    expect(getPublicApiDeps().limiters).toBe(getPublicApiDeps().limiters);
  });

  it("verifies manage tokens with ENCRYPTION_KEY and complains clearly without it", () => {
    const deps = getPublicApiDeps();
    const token = makeManageToken("booking-1", KEY);
    expect(() => deps.verifyManageToken(token)).toThrow(/ENCRYPTION_KEY is required/);
    env.ENCRYPTION_KEY = KEY;
    expect(deps.verifyManageToken(token)).toBe("booking-1");
    expect(deps.verifyManageToken("booking-1.forged")).toBeNull();
  });

  it("verifies Turnstile with the environment's secret", async () => {
    const deps = getPublicApiDeps();
    expect((await deps.verifyTurnstile(undefined, "1.2.3.4")).ok).toBe(true);
    env.NODE_ENV = "production";
    expect(await deps.verifyTurnstile("t", "1.2.3.4")).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(deps.now()).toBeInstanceOf(Date);
    expect(deps.trustedProxyHops).toBe(1);
  });
});
