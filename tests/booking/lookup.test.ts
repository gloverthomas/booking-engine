import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bookingService } from "@/db/schema";
import { getBookingByToken } from "@/server/booking";
import { makeManageToken } from "@/server/manage-token";
import { createService } from "../helpers/factories";
import { createWorld, local, offer, type World } from "../availability/setup";
import { KEY, confirmed, hold, opts } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await w.t.client.close();
});

describe("getBookingByToken", () => {
  test("returns the public summary for a valid token", async () => {
    const colour = await createService(w.db, w.businessId, {
      name: "Colour",
      durationMin: 60,
      priceCents: 15000,
      bufferMin: 20,
    });
    await offer(w.db, colour.id, w.locationId, w.staffId);
    const result = await confirmed(w, { serviceIds: [w.haircutId, colour.id] });

    const summary = await getBookingByToken(w.db, result.manageToken, opts);
    expect(summary).toEqual({
      bookingId: result.bookingId,
      status: "confirmed",
      start: local("2026-11-02T10:00"),
      end: local("2026-11-02T11:45"), // buffer excluded
      locationName: "Northside",
      services: [
        { name: "Maintenance Haircut", priceCents: 9500 },
        { name: "Colour", priceCents: 15000 },
      ],
      totalCents: 24500,
      depositCents: 12250,
    });
  });

  test("reflects the live status", async () => {
    const result = await hold(w);
    expect((await getBookingByToken(w.db, result.manageToken, opts))?.status).toBe(
      "pending_payment",
    );
  });

  test("returns null for tampered, malformed or unknown tokens", async () => {
    const result = await hold(w);
    expect(await getBookingByToken(w.db, `${result.manageToken}x`, opts)).toBeNull();
    expect(await getBookingByToken(w.db, "garbage", opts)).toBeNull();
    expect(await getBookingByToken(w.db, "", opts)).toBeNull();
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    expect(
      await getBookingByToken(w.db, result.manageToken, { encryptionKey: otherKey }),
    ).toBeNull();
    // valid signature for a booking that does not exist
    const ghost = makeManageToken("00000000-0000-4000-8000-000000000000", KEY);
    expect(await getBookingByToken(w.db, ghost, opts)).toBeNull();
    // authentic signature over a non-uuid id never reaches the database
    expect(await getBookingByToken(w.db, makeManageToken("not-a-uuid", KEY), opts)).toBeNull();
  });

  test("a booking whose services were all removed falls back to the stored range", async () => {
    const result = await hold(w);
    await w.db.delete(bookingService);
    const summary = await getBookingByToken(w.db, result.manageToken, opts);
    expect(summary?.end).toEqual(local("2026-11-02T10:45"));
    expect(summary?.services).toEqual([]);
  });
});

describe("ENCRYPTION_KEY handling", () => {
  test("reads ENCRYPTION_KEY from the environment when no key is injected", async () => {
    const result = await hold(w);
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/x");
    vi.stubEnv("ENCRYPTION_KEY", KEY);
    const { getBookingByToken: fresh } = await import("@/server/booking");
    expect((await fresh(w.db, result.manageToken))?.bookingId).toBe(result.bookingId);
  });

  test("fails with a clear message only when the key is actually needed", async () => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/x");
    vi.stubEnv("ENCRYPTION_KEY", "");
    const { resolveEncryptionKey } = await import("@/server/booking/shared");
    expect(() => resolveEncryptionKey()).toThrow(/ENCRYPTION_KEY is not set/);
  });
});
