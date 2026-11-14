import { beforeEach, describe, expect, test } from "vitest";
import { integrationAccount, staff, timeBlock } from "@/db/schema";
import {
  ProviderGoneError,
  AuthRevokedError,
  TransientProviderError,
} from "@/server/integrations/common/errors";
import { syncGoogleCalendar } from "@/server/integrations/google/inbound";
import type { GoogleDeps } from "@/server/integrations/google/runtime";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import {
  busyEvent,
  fakeGoogle,
  fixedNow,
  NOW,
  seedAccount,
  seedBooking,
  silentLog,
  testEnv,
  type BookingSeed,
  type FakeGoogle,
} from "../helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("Google inbound sync", () => {
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
  const blocks = async () => t.db.select().from(timeBlock).orderBy(timeBlock.externalId);
  const state = async () => (await t.db.select().from(integrationAccount))[0].syncState;

  test("first sync is full: upserts busy events, stores the token and window", async () => {
    google.listResponses.push({
      events: [
        busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z"),
        busyEvent("ours", "2026-11-20T03:00:00Z", "2026-11-20T04:00:00Z", {
          extendedProperties: { private: { source: "booking-engine" } },
        }),
        busyEvent("free", "2026-11-20T05:00:00Z", "2026-11-20T06:00:00Z", {
          transparency: "transparent",
        }),
        {
          id: "allday",
          summary: "Away",
          start: { date: "2026-11-25" },
          end: { date: "2026-11-26" },
        },
      ],
      nextSyncToken: "tok-1",
    });

    const result = await syncGoogleCalendar(deps);

    expect(result.mode).toBe("full");
    expect(google.listParams[0].syncToken).toBeUndefined();
    expect(google.listParams[0].timeMin).toEqual(new Date(NOW.getTime() - 86_400_000));
    const rows = await blocks();
    expect(rows.map((r) => r.externalId)).toEqual(["a", "allday"]);
    expect(rows.every((r) => r.source === "google" && r.staffId === seed.staffId)).toBe(true);
    expect(rows[1].during.start).toEqual(new Date("2026-11-24T13:00:00.000Z"));
    const s = await state();
    expect(s.syncToken).toBe("tok-1");
    expect(s.calendarId).toBe("primary");
    expect(typeof s.windowEnd).toBe("string");
  });

  test("second sync is incremental: updates, deletes cancelled events", async () => {
    google.listResponses.push({
      events: [
        busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z"),
        busyEvent("b", "2026-11-21T01:00:00Z", "2026-11-21T02:00:00Z"),
      ],
      nextSyncToken: "tok-1",
    });
    await syncGoogleCalendar(deps);

    google.listResponses.push({
      events: [
        busyEvent("a", "2026-11-20T02:00:00Z", "2026-11-20T03:30:00Z"),
        { id: "b", status: "cancelled" },
      ],
      nextSyncToken: "tok-2",
    });
    const result = await syncGoogleCalendar(deps);

    expect(result.mode).toBe("incremental");
    expect(google.listParams[1].syncToken).toBe("tok-1");
    expect(google.listParams[1].timeMin).toBeUndefined();
    const rows = await blocks();
    expect(rows).toHaveLength(1);
    expect(rows[0].during.end).toEqual(new Date("2026-11-20T03:30:00.000Z"));
    expect((await state()).syncToken).toBe("tok-2");
  });

  test("a recurring series arrives as expanded instances, each its own block", async () => {
    google.listResponses.push({
      events: [
        busyEvent("series_20261120T010000Z", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z"),
        busyEvent("series_20261127T010000Z", "2026-11-27T01:00:00Z", "2026-11-27T02:00:00Z"),
      ],
      nextSyncToken: "tok-1",
    });
    await syncGoogleCalendar(deps);
    expect(await blocks()).toHaveLength(2);

    // One instance is cancelled later: only that block goes.
    google.listResponses.push({
      events: [{ id: "series_20261127T010000Z", status: "cancelled" }],
      nextSyncToken: "tok-2",
    });
    await syncGoogleCalendar(deps);
    expect((await blocks()).map((b) => b.externalId)).toEqual(["series_20261120T010000Z"]);
  });

  test("an event that becomes free (transparent) loses its block", async () => {
    google.listResponses.push({
      events: [busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
      nextSyncToken: "tok-1",
    });
    await syncGoogleCalendar(deps);
    google.listResponses.push({
      events: [
        busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z", {
          transparency: "transparent",
        }),
      ],
      nextSyncToken: "tok-2",
    });
    await syncGoogleCalendar(deps);
    expect(await blocks()).toHaveLength(0);
  });

  test("follows pagination to the last page", async () => {
    google.listResponses.push(
      {
        events: [busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
        nextPageToken: "p2",
      },
      {
        events: [busyEvent("b", "2026-11-21T01:00:00Z", "2026-11-21T02:00:00Z")],
        nextSyncToken: "tok-1",
      },
    );
    await syncGoogleCalendar(deps);
    expect(google.listParams[1].pageToken).toBe("p2");
    expect(await blocks()).toHaveLength(2);
    expect((await state()).syncToken).toBe("tok-1");
  });

  test("410 Gone on the sync token falls back to a full resync and prunes removed events", async () => {
    google.listResponses.push({
      events: [
        busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z"),
        busyEvent("stale", "2026-11-21T01:00:00Z", "2026-11-21T02:00:00Z"),
      ],
      nextSyncToken: "tok-1",
    });
    await syncGoogleCalendar(deps);

    google.listResponses.push(new ProviderGoneError("sync token expired"), {
      events: [busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
      nextSyncToken: "tok-fresh",
    });
    const result = await syncGoogleCalendar(deps);

    expect(result.mode).toBe("full");
    expect(google.listParams[2].syncToken).toBeUndefined();
    expect((await blocks()).map((b) => b.externalId)).toEqual(["a"]);
    expect((await state()).syncToken).toBe("tok-fresh");
  });

  test("a full sync that returns nothing clears every Google block", async () => {
    google.listResponses.push({
      events: [busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
      nextSyncToken: "tok-1",
    });
    await syncGoogleCalendar(deps);
    google.listResponses.push({ events: [], nextSyncToken: "tok-2" });
    await syncGoogleCalendar(deps, { forceFull: true });
    expect(await blocks()).toHaveLength(0);
  });

  test("manual blocks are never touched by a full resync", async () => {
    await t.db.insert(timeBlock).values({
      staffId: seed.staffId,
      during: { start: new Date("2026-12-01T00:00:00Z"), end: new Date("2026-12-02T00:00:00Z") },
      source: "manual",
    });
    google.listResponses.push({ events: [], nextSyncToken: "t" });
    await syncGoogleCalendar(deps);
    expect(await blocks()).toHaveLength(1);
  });

  test("rolls the window forward with a full sync when it is nearly exhausted", async () => {
    await t.db.update(integrationAccount).set({
      syncState: {
        calendarId: "primary",
        syncToken: "old",
        windowEnd: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(),
      },
    });
    const result = await syncGoogleCalendar(deps);
    expect(result.mode).toBe("full");
    expect(google.listParams[0].timeMax).toEqual(new Date(NOW.getTime() + 180 * 86_400_000));
  });

  test("uses the configured staff member, else the first active one", async () => {
    const [other] = await t.db
      .insert(staff)
      .values({ businessId: seed.businessId, name: "Second" })
      .returning();
    await t.db
      .update(integrationAccount)
      .set({ syncState: { calendarId: "primary", staffId: other.id } });
    google.listResponses.push({
      events: [busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
      nextSyncToken: "t",
    });
    await syncGoogleCalendar(deps);
    expect((await blocks())[0].staffId).toBe(other.id);
  });

  test("with no active staff the sync is skipped", async () => {
    await t.db.update(staff).set({ active: false });
    const result = await syncGoogleCalendar(deps);
    expect(result.mode).toBe("skipped");
    expect(google.listParams).toHaveLength(0);
  });

  test("not connected: skipped", async () => {
    await t.db.update(integrationAccount).set({ status: "disconnected" });
    expect((await syncGoogleCalendar(deps)).mode).toBe("skipped");
  });

  test("a revoked token sets status 'error' with lastError for the admin 'reconnect' prompt", async () => {
    google.listResponses.push(new AuthRevokedError("invalid_grant"));
    const result = await syncGoogleCalendar(deps);
    expect(result.mode).toBe("skipped");
    const acc = (await t.db.select().from(integrationAccount))[0];
    expect(acc.status).toBe("error");
    expect(acc.lastError).toMatch(/Reconnect/);
  });

  test("other failures are recorded and rethrown", async () => {
    google.listResponses.push(new TransientProviderError("google 503"));
    await expect(syncGoogleCalendar(deps)).rejects.toThrow("google 503");
    const acc = (await t.db.select().from(integrationAccount))[0];
    expect(acc.status).toBe("connected");
    expect(acc.lastError).toBe("google 503");
  });

  test("a sync that fails mid-way leaves no partial state or token behind", async () => {
    google.listResponses.push(
      {
        events: [busyEvent("a", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z")],
        nextPageToken: "p2",
      },
      new TransientProviderError("page 2 failed"),
    );
    await expect(syncGoogleCalendar(deps)).rejects.toThrow("page 2 failed");
    expect(await blocks()).toHaveLength(0);
    expect((await state()).syncToken).toBeUndefined();
  });

  test("returns 'busy' when another sync holds the lock", async () => {
    // PGlite has a single connection and advisory locks are re-entrant per session, so
    // contention is simulated by making the lock query report "not acquired".
    const contended = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            fn(
              new Proxy(target, {
                get: (inner, innerProp) =>
                  innerProp === "execute"
                    ? async () => ({ rows: [{ locked: false }] })
                    : Reflect.get(inner, innerProp, inner),
              }),
            );
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = await syncGoogleCalendar({ ...deps, db: contended });
    expect(result.mode).toBe("busy");
    expect(google.listParams).toHaveLength(0);
  });
});
