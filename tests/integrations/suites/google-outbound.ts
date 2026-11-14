import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { booking, integrationAccount } from "@/db/schema";
import {
  ProviderConflictError,
  ProviderNotFoundError,
  RateLimitedError,
  AuthRevokedError,
  TransientProviderError,
} from "@/server/integrations/common/errors";
import {
  handleGoogleDomainEvent,
  pushBookingToCalendar,
} from "@/server/integrations/google/outbound";
import type { GoogleDeps } from "@/server/integrations/google/runtime";
import { deterministicEventId } from "@/server/integrations/google/event-mapper";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import {
  fakeGoogle,
  fixedNow,
  seedAccount,
  seedBooking,
  silentLog,
  testEnv,
  type BookingSeed,
  type FakeGoogle,
} from "../helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("consumer.google outbound", () => {
  let t: TestDb;
  let seed: BookingSeed;
  let google: FakeGoogle;
  let deps: GoogleDeps;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
    await seedAccount(t.db, seed.businessId, "google");
    google = fakeGoogle();
    deps = {
      db: t.db,
      env: testEnv(),
      now: fixedNow,
      log: silentLog,
      createPort: async () => google,
    };
  });
  const gcalId = async () =>
    (await t.db.select().from(booking).where(eq(booking.id, seed.bookingId)))[0].gcalEventId;
  const account = async () => (await t.db.select().from(integrationAccount))[0];

  test("booking.confirmed creates the event with a deterministic id and stores it", async () => {
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });

    const id = deterministicEventId(seed.bookingId);
    expect(google.calls[0].method).toBe("insert");
    const [calendarId, eventId, event] = google.calls[0].args as [string, string, never];
    expect(calendarId).toBe("primary");
    expect(eventId).toBe(id);
    expect(event).toMatchObject({
      summary: "Sam Client - Haircut, Beard trim",
      timeZone: "Australia/Melbourne",
      privateProps: { bookingId: seed.bookingId, source: "booking-engine" },
    });
    expect(await gcalId()).toBe(id);
    expect((await account()).lastSyncAt).not.toBeNull();
  });

  test("redelivery of the same event patches instead of duplicating", async () => {
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    expect(google.calls.map((c) => c.method)).toEqual(["insert", "patch"]);
  });

  test("a 409 on insert (event survived a crash before the db write) is patched back to confirmed", async () => {
    google.insertError = new ProviderConflictError("exists");
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    expect(google.calls.map((c) => c.method)).toEqual(["insert", "patch"]);
    expect(google.calls[1].args[2]).toMatchObject({ status: "confirmed" });
    expect(await gcalId()).toBe(deterministicEventId(seed.bookingId));
  });

  test("booking.rescheduled patches the new times", async () => {
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    const newStart = new Date("2026-11-21T00:00:00.000Z");
    await t.db
      .update(booking)
      .set({ during: { start: newStart, end: new Date("2026-11-21T01:15:00.000Z") } })
      .where(eq(booking.id, seed.bookingId));
    await handleGoogleDomainEvent(deps, {
      type: "booking.rescheduled",
      bookingId: seed.bookingId,
    });
    const patch = google.calls.at(-1)!;
    expect(patch.method).toBe("patch");
    expect((patch.args[2] as { start: Date }).start).toEqual(newStart);
  });

  test("a rescheduled booking whose event was deleted by hand is recreated", async () => {
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    google.patchError = new ProviderNotFoundError("gone");
    await handleGoogleDomainEvent(deps, {
      type: "booking.rescheduled",
      bookingId: seed.bookingId,
    });
    expect(google.calls.map((c) => c.method)).toEqual(["insert", "patch", "insert"]);
  });

  test.each(["booking.cancelled", "booking.no_show"] as const)(
    "%s deletes the event and clears the id; repeating is a no-op",
    async (type) => {
      await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
      await handleGoogleDomainEvent(deps, { type, bookingId: seed.bookingId });
      expect(google.calls.at(-1)!.method).toBe("delete");
      expect(await gcalId()).toBeNull();
      const before = google.calls.length;
      await handleGoogleDomainEvent(deps, { type, bookingId: seed.bookingId });
      expect(google.calls.length).toBe(before);
    },
  );

  test("deleting an already-missing event still clears the id", async () => {
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    google.deleteError = new ProviderNotFoundError("gone");
    await handleGoogleDomainEvent(deps, { type: "booking.cancelled", bookingId: seed.bookingId });
    expect(await gcalId()).toBeNull();
  });

  test("ignores event types it does not handle and events without a booking", async () => {
    await handleGoogleDomainEvent(deps, { type: "payment.succeeded" });
    await handleGoogleDomainEvent(deps, { type: "booking.completed", bookingId: seed.bookingId });
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed" });
    expect(google.calls).toHaveLength(0);
  });

  test("a booking that is no longer live is not pushed; a missing booking is skipped", async () => {
    await t.db
      .update(booking)
      .set({ status: "cancelled_by_client" })
      .where(eq(booking.id, seed.bookingId));
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    await handleGoogleDomainEvent(deps, {
      type: "booking.confirmed",
      bookingId: "00000000-0000-4000-8000-000000000000",
    });
    expect(google.calls).toHaveLength(0);
  });

  test("not connected: skipped quietly", async () => {
    await t.db.update(integrationAccount).set({ status: "disconnected" });
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    expect(google.calls).toHaveLength(0);
  });

  test("a revoked token flips the account to 'error' and drops the event without retrying", async () => {
    google.insertError = new AuthRevokedError("invalid_grant");
    await expect(
      handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId }),
    ).resolves.toBeUndefined();
    const acc = await account();
    expect(acc.status).toBe("error");
    expect(acc.lastError).toMatch(/Reconnect/);
  });

  test("a transient failure is recorded on lastError and rethrown so the queue retries", async () => {
    google.insertError = new TransientProviderError("boom");
    await expect(
      handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId }),
    ).rejects.toThrow("boom");
    const acc = await account();
    expect(acc.status).toBe("connected");
    expect(acc.lastError).toBe("boom");

    // The retry succeeds and clears the error.
    google.insertError = undefined;
    await handleGoogleDomainEvent(deps, { type: "booking.confirmed", bookingId: seed.bookingId });
    expect((await account()).lastError).toBeNull();
  });

  test("rate limits shorter than the cap are waited out in-process", async () => {
    let attempts = 0;
    const flaky = fakeGoogle();
    const original = flaky.insertEvent;
    flaky.insertEvent = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new RateLimitedError("slow down", 0);
      return original(...args);
    };
    const fast = { ...deps, createPort: async () => flaky };
    await handleGoogleDomainEvent(fast, { type: "booking.confirmed", bookingId: seed.bookingId });
    expect(attempts).toBe(2);
  }, 10_000);

  test("pushBookingToCalendar is the reconcile entry point", async () => {
    await pushBookingToCalendar(deps, seed.bookingId);
    expect(google.calls[0].method).toBe("insert");
  });
});
