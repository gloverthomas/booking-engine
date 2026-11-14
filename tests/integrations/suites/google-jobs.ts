import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { booking, integrationAccount, webhookEvent } from "@/db/schema";
import {
  GOOGLE_JOBS,
  runChannelRenewalJob,
  runGoogleReconcile,
  runGoogleSyncJob,
} from "@/server/integrations/google/jobs";
import type { GoogleDeps } from "@/server/integrations/google/runtime";
import { register } from "@/worker/handlers/google";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import {
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

describe("google jobs", () => {
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
  test("poll job syncs, makes sure a channel exists and prunes old webhook dedupe rows", async () => {
    await t.db.insert(webhookEvent).values([
      { provider: "google", eventId: "old", receivedAt: new Date(NOW.getTime() - 8 * 86_400_000) },
      { provider: "google", eventId: "new", receivedAt: new Date(NOW.getTime() - 3_600_000) },
      {
        provider: "stripe",
        eventId: "keep",
        receivedAt: new Date(NOW.getTime() - 30 * 86_400_000),
      },
    ]);
    await runGoogleSyncJob(deps);
    expect(google.listParams).toHaveLength(1);
    expect(google.watches).toHaveLength(1);
    const left = (await t.db.select().from(webhookEvent)).map((r) => r.eventId).sort();
    expect(left).toEqual(["keep", "new"]);
  });

  test("renewal job renews, then resyncs to catch anything missed in the gap", async () => {
    await runChannelRenewalJob(deps);
    expect(google.watches).toHaveLength(1);
    expect(google.listParams).toHaveLength(1);

    google.listParams.length = 0;
    await runChannelRenewalJob(deps);
    expect(google.watches).toHaveLength(1);
    expect(google.listParams).toHaveLength(0);
  });

  test("reconcile pushes future confirmed bookings that have no event", async () => {
    expect(await runGoogleReconcile(deps)).toBe(1);
    expect(google.calls.map((c) => c.method)).toEqual(["insert"]);
    expect(await runGoogleReconcile(deps)).toBe(0);
  });

  test("reconcile removes events of bookings that were cancelled while we could not reach Google", async () => {
    await t.db
      .update(booking)
      .set({ status: "cancelled_by_client", gcalEventId: "orphan" })
      .where(eq(booking.id, seed.bookingId));
    expect(await runGoogleReconcile(deps)).toBe(1);
    expect(google.calls[0]).toMatchObject({ method: "delete", args: ["primary", "orphan"] });
  });

  test("reconcile ignores past bookings and does nothing when Google is not connected", async () => {
    await t.db
      .update(booking)
      .set({
        during: {
          start: new Date("2026-01-01T00:00:00Z"),
          end: new Date("2026-01-01T01:00:00Z"),
        },
      })
      .where(eq(booking.id, seed.bookingId));
    expect(await runGoogleReconcile(deps)).toBe(0);
    await t.db.update(integrationAccount).set({ status: "error" });
    expect(await runGoogleReconcile(deps)).toBe(0);
  });
});

describe("google worker registration", () => {
  test("registers the consumer with retry/backoff and the three scheduled jobs", async () => {
    const handlers = new Map<string, (jobs: Array<{ data: unknown }>) => Promise<void>>();
    const boss = {
      createQueue: vi.fn(async () => {}),
      updateQueue: vi.fn(async () => {}),
      schedule: vi.fn(async (_name: string, _cron: string) => {}),
      work: vi.fn(async (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest.at(-1) as never);
        return "id";
      }),
    };
    const t = shared.current;
    const seed = await seedBooking(t.db);
    vi.stubEnv("DATABASE_URL", "postgres://ci:ci@localhost:5432/ci");

    await register({
      boss: boss as unknown as PgBoss,
      db: t.db,
      log: silentLog,
      now: fixedNow,
    });

    expect(boss.createQueue).toHaveBeenCalledWith(
      GOOGLE_JOBS.consumer,
      expect.objectContaining({ retryBackoff: true, retryLimit: 10 }),
    );
    expect(boss.updateQueue).toHaveBeenCalledWith(
      GOOGLE_JOBS.consumer,
      expect.objectContaining({ retryBackoff: true }),
    );
    expect(boss.schedule.mock.calls.map((c) => c[0])).toEqual([
      GOOGLE_JOBS.sync,
      GOOGLE_JOBS.renewChannel,
      GOOGLE_JOBS.reconcile,
    ]);
    expect(boss.schedule).toHaveBeenCalledWith(GOOGLE_JOBS.sync, "*/15 * * * *");

    // Not connected: every handler runs its real code path and ends quietly.
    await handlers.get(GOOGLE_JOBS.consumer)!([
      { data: { type: "booking.confirmed", bookingId: seed.bookingId } },
      { data: { type: "payment.succeeded" } },
    ]);
    for (const name of [GOOGLE_JOBS.sync, GOOGLE_JOBS.renewChannel, GOOGLE_JOBS.reconcile]) {
      await expect(handlers.get(name)!([])).resolves.toBeUndefined();
    }
    vi.unstubAllEnvs();
  });
});
