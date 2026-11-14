import { beforeEach, describe, expect, test, vi } from "vitest";
import { integrationAccount, webhookEvent } from "@/db/schema";
import { AuthRevokedError } from "@/server/integrations/common/errors";
import {
  CHANNEL_TTL_SECONDS,
  deriveChannelToken,
  ensureWatchChannel,
  handleGoogleWebhook,
  readWebhookHeaders,
  stopWatchChannel,
  type WebhookDeps,
} from "@/server/integrations/google/channel";
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
  TEST_KEY,
  type BookingSeed,
  type FakeGoogle,
} from "../helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("Google push channel", () => {
  let t: TestDb;
  let seed: BookingSeed;
  let google: FakeGoogle;
  let deps: WebhookDeps;
  let kick: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
    await seedAccount(t.db, seed.businessId, "google");
    google = fakeGoogle();
    kick = vi.fn<() => void>();
    deps = {
      db: t.db,
      env: testEnv(),
      now: fixedNow,
      log: silentLog,
      createPort: async () => google,
      kickSync: kick,
    };
  });
  const syncState = async () => (await t.db.select().from(integrationAccount))[0].syncState;

  test("creates a channel with a derived secret token and the webhook address", async () => {
    expect(await ensureWatchChannel(deps)).toEqual({ action: "created" });
    const req = google.watches[0];
    expect(req.address).toBe("https://book.example.com/api/integrations/google/webhook");
    expect(req.ttlSeconds).toBe(CHANNEL_TTL_SECONDS);
    expect(req.token).toBe(deriveChannelToken(TEST_KEY, req.channelId));
    const channel = (await syncState()).channel as { id: string; resourceId: string };
    expect(channel).toMatchObject({ id: req.channelId, resourceId: "res-1" });
  });

  test("leaves a healthy channel alone, renews one near expiry and stops the old one after", async () => {
    await ensureWatchChannel(deps);
    expect(await ensureWatchChannel(deps)).toEqual({ action: "unchanged" });

    const later = { ...deps, now: () => new Date(NOW.getTime() + 6 * 86_400_000) };
    expect(await ensureWatchChannel(later)).toEqual({ action: "renewed" });
    expect(google.watches).toHaveLength(2);
    const methods = google.calls.map((c) => c.method);
    expect(methods.indexOf("stop")).toBeGreaterThan(methods.lastIndexOf("watch") - 1);
    expect(google.calls.find((c) => c.method === "stop")!.args).toEqual([
      google.watches[0].channelId,
      "res-1",
    ]);
    const channel = (await syncState()).channel as { id: string };
    expect(channel.id).toBe(google.watches[1].channelId);
  });

  test("force replaces even a healthy channel; a failing stop of the old channel is tolerated", async () => {
    await ensureWatchChannel(deps);
    google.stopChannel = async () => {
      throw new Error("already gone");
    };
    expect(await ensureWatchChannel(deps, { force: true })).toEqual({ action: "renewed" });
  });

  test("skips on a non-https APP_URL (Google only delivers to https)", async () => {
    const local = { ...deps, env: testEnv({ APP_URL: "http://localhost:3000" }) };
    expect(await ensureWatchChannel(local)).toEqual({ action: "skipped" });
    expect(google.watches).toHaveLength(0);
  });

  test("skips when not connected", async () => {
    await t.db.update(integrationAccount).set({ status: "disconnected" });
    expect(await ensureWatchChannel(deps)).toEqual({ action: "skipped" });
  });

  test("failures are recorded; a revoked token is not rethrown", async () => {
    google.watchError = new Error("quota");
    await expect(ensureWatchChannel(deps)).rejects.toThrow("quota");
    expect((await t.db.select().from(integrationAccount))[0].lastError).toBe("quota");

    google.watchError = new AuthRevokedError("invalid_grant");
    expect(await ensureWatchChannel(deps)).toEqual({ action: "skipped" });
    expect((await t.db.select().from(integrationAccount))[0].status).toBe("error");
  });

  test("stopWatchChannel stops the current channel and never throws", async () => {
    await ensureWatchChannel(deps);
    await stopWatchChannel(deps);
    expect(google.calls.at(-1)!.method).toBe("stop");
    google.stopChannel = async () => {
      throw new Error("nope");
    };
    await expect(stopWatchChannel(deps)).resolves.toBeUndefined();
  });

  test("stopWatchChannel without a channel does nothing", async () => {
    await stopWatchChannel(deps);
    expect(google.calls).toHaveLength(0);
  });
});

describe("Google webhook", () => {
  let t: TestDb;
  let google: FakeGoogle;
  let deps: WebhookDeps;
  let kick: ReturnType<typeof vi.fn<() => void>>;
  let channelId: string;

  beforeEach(async () => {
    t = shared.current;
    const seed = await seedBooking(t.db);
    await seedAccount(t.db, seed.businessId, "google");
    google = fakeGoogle();
    kick = vi.fn<() => void>();
    deps = {
      db: t.db,
      env: testEnv(),
      now: fixedNow,
      log: silentLog,
      createPort: async () => google,
      kickSync: kick,
    };
    await ensureWatchChannel(deps);
    channelId = google.watches[0].channelId;
  });
  const headers = (over: Record<string, string | null> = {}) => ({
    channelId,
    channelToken: deriveChannelToken(TEST_KEY, channelId),
    resourceState: "exists",
    messageNumber: "1",
    ...over,
  });

  test("a genuine change notification starts a sync, once per message", async () => {
    expect(await handleGoogleWebhook(deps, headers())).toEqual({
      status: 200,
      result: "sync_started",
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(await handleGoogleWebhook(deps, headers())).toEqual({
      status: 200,
      result: "duplicate",
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(await handleGoogleWebhook(deps, headers({ messageNumber: "2" }))).toMatchObject({
      result: "sync_started",
    });
    const rows = await t.db.select().from(webhookEvent);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.processedAt !== null)).toBe(true);
  });

  test("the handshake message is acknowledged without syncing", async () => {
    expect(await handleGoogleWebhook(deps, headers({ resourceState: "sync" }))).toEqual({
      status: 200,
      result: "sync_ack",
    });
    expect(kick).not.toHaveBeenCalled();
  });

  test("a wrong token is rejected with 403 and does nothing", async () => {
    expect(await handleGoogleWebhook(deps, headers({ channelToken: "guess" }))).toEqual({
      status: 403,
      result: "forbidden",
    });
    const forged = deriveChannelToken(TEST_KEY, "some-other-channel");
    expect(await handleGoogleWebhook(deps, headers({ channelToken: forged }))).toMatchObject({
      status: 403,
    });
    expect(kick).not.toHaveBeenCalled();
  });

  test("missing headers are a 400; an unknown or stale channel is a 404", async () => {
    expect(await handleGoogleWebhook(deps, headers({ channelToken: null }))).toMatchObject({
      status: 400,
    });
    expect(await handleGoogleWebhook(deps, headers({ channelId: null }))).toMatchObject({
      status: 400,
    });
    expect(await handleGoogleWebhook(deps, headers({ channelId: "stale-channel" }))).toMatchObject({
      status: 404,
    });
    await t.db.update(integrationAccount).set({ status: "disconnected" });
    expect(await handleGoogleWebhook(deps, headers())).toMatchObject({ status: 404 });
  });

  test("works without a message number header", async () => {
    expect(await handleGoogleWebhook(deps, headers({ messageNumber: null }))).toMatchObject({
      result: "sync_started",
    });
  });

  test("readWebhookHeaders maps the X-Goog headers", () => {
    const parsed = readWebhookHeaders(
      new Headers({
        "x-goog-channel-id": "c",
        "x-goog-channel-token": "t",
        "x-goog-resource-state": "exists",
        "x-goog-message-number": "9",
      }),
    );
    expect(parsed).toEqual({
      channelId: "c",
      channelToken: "t",
      resourceState: "exists",
      messageNumber: "9",
    });
  });
});
