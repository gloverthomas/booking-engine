import { beforeEach, describe, expect, test, vi } from "vitest";
import { integrationAccount, timeBlock } from "@/db/schema";
import { decryptJson } from "@/server/crypto";
import {
  googleCallback,
  googleConnect,
  googleDisconnect,
  googleWebhook,
  type GoogleRouteDeps,
} from "@/server/integrations/google/routes";
import type { GoogleAuthPort, GoogleTokens } from "@/server/integrations/google/port";
import { deriveChannelToken, ensureWatchChannel } from "@/server/integrations/google/channel";
import type { Permission } from "@/server/auth/permissions";
import type { GoogleAccessSession } from "@/server/integrations/google/access";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import {
  fakeGoogle,
  fixedNow,
  seedAccount,
  seedBooking,
  silentLog,
  testEnv,
  TEST_KEY,
  type BookingSeed,
  type FakeGoogle,
} from "../helpers";

const messageOf = (res: Response): string =>
  new URL(res.headers.get("location")!).searchParams.get("message") ?? "";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("google routes", () => {
  let t: TestDb;
  let seed: BookingSeed;
  let google: FakeGoogle;
  let authPort: GoogleAuthPort & { exchangeCode: ReturnType<typeof vi.fn> };
  let afterTasks: Array<() => Promise<void>>;
  let requireAccess: ReturnType<
    typeof vi.fn<(permission: Permission) => Promise<GoogleAccessSession>>
  >;
  let deps: GoogleRouteDeps;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
    google = fakeGoogle();
    afterTasks = [];
    requireAccess = vi.fn<(permission: Permission) => Promise<GoogleAccessSession>>(async () => ({
      staffId: null,
      role: "owner",
    }));
    authPort = {
      buildAuthUrl: vi.fn(
        async ({ state, codeChallenge }) =>
          `https://accounts.google.com/auth?state=${state}&cc=${codeChallenge}`,
      ),
      exchangeCode: vi.fn(async (): Promise<GoogleTokens> => ({
        accessToken: "at",
        refreshToken: "rt",
        expiryDate: 1,
      })),
    };
    deps = {
      db: t.db,
      env: testEnv(),
      now: fixedNow,
      log: silentLog,
      createPort: async () => google,
      requireAccess,
      authPort,
      runAfter: (task) => afterTasks.push(task),
    };
  });
  /** Runs connect and returns the state + cookie header the browser would send back. */
  async function startConnect(query = "") {
    const res = await googleConnect(
      new Request(`https://book.example.com/api/integrations/google/connect${query}`),
      deps,
    );
    const location = new URL(res.headers.get("location")!);
    const cookie = res.headers.get("set-cookie")!;
    return { res, state: location.searchParams.get("state")!, cookie: cookie.split(";")[0] };
  }

  const callbackReq = (qs: string, cookie?: string) =>
    new Request(`https://book.example.com/api/integrations/google/callback?${qs}`, {
      headers: cookie ? { cookie } : {},
    });

  test("connect requires integrations.manage and redirects to Google with state, PKCE and a secure cookie", async () => {
    const { res, state } = await startConnect();
    expect(requireAccess).toHaveBeenCalledWith("integrations.manage");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
    expect(res.headers.get("location")).toContain("cc=");
    expect(state.length).toBeGreaterThan(20);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\/api\/integrations\/google/);
    expect(authPort.buildAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://book.example.com/api/integrations/google/callback",
      }),
    );
  });

  test("connect propagates an owner-guard failure and rejects a bad calendarId", async () => {
    requireAccess.mockRejectedValueOnce(new Error("not signed in"));
    await expect(
      googleConnect(new Request("https://x.test/api/integrations/google/connect"), deps),
    ).rejects.toThrow("not signed in");
    const res = await googleConnect(
      new Request(`https://x.test/c?calendarId=${"a".repeat(300)}`),
      deps,
    );
    expect(res.status).toBe(400);
  });

  test("callback with a valid state stores encrypted tokens, the calendar id and kicks a first sync", async () => {
    const { state, cookie } = await startConnect("?calendarId=work%40example.com");
    const res = await googleCallback(callbackReq(`code=abc&state=${state}`, cookie), deps);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=connected");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(authPort.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "abc", codeVerifier: expect.any(String) }),
    );

    const [acc] = await t.db.select().from(integrationAccount);
    expect(acc.status).toBe("connected");
    expect(acc.externalAccountId).toBe("work@example.com");
    expect(acc.syncState).toEqual({ calendarId: "work@example.com" });
    expect(acc.encryptedTokens).not.toContain("rt");
    expect(decryptJson<GoogleTokens>(acc.encryptedTokens!, TEST_KEY).refreshToken).toBe("rt");

    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(google.listParams.length).toBeGreaterThan(0);
    expect(google.watches).toHaveLength(1);
  });

  test("a failing first sync is logged, not thrown", async () => {
    const { state, cookie } = await startConnect();
    await googleCallback(callbackReq(`code=abc&state=${state}`, cookie), deps);
    google.listResponses.push(new Error("google down"));
    await expect(afterTasks[0]()).resolves.toBeUndefined();
  });

  test("callback rejects a forged state, a missing cookie and a user denial; nothing is stored", async () => {
    const { cookie } = await startConnect();
    const forged = await googleCallback(callbackReq("code=abc&state=attacker", cookie), deps);
    expect(forged.headers.get("location")).toContain("status=error");
    const noCookie = await googleCallback(callbackReq("code=abc&state=x"), deps);
    expect(noCookie.headers.get("location")).toContain("status=error");
    const denied = await googleCallback(callbackReq("error=access_denied", cookie), deps);
    expect(messageOf(denied)).toContain("cancelled or denied");
    expect(authPort.exchangeCode).not.toHaveBeenCalled();
    expect(await t.db.select().from(integrationAccount)).toHaveLength(0);
  });

  test("callback without a code, without a refresh token, or when the exchange fails is an error redirect", async () => {
    const first = await startConnect();
    const noCode = await googleCallback(callbackReq(`state=${first.state}`, first.cookie), deps);
    expect(messageOf(noCode)).toContain("authorisation code");

    authPort.exchangeCode.mockResolvedValueOnce({ accessToken: "x" });
    const second = await startConnect();
    const noRefresh = await googleCallback(
      callbackReq(`code=c&state=${second.state}`, second.cookie),
      deps,
    );
    expect(messageOf(noRefresh)).toContain("refresh token");

    authPort.exchangeCode.mockRejectedValueOnce(new Error("boom"));
    const third = await startConnect();
    const failed = await googleCallback(
      callbackReq(`code=c&state=${third.state}`, third.cookie),
      deps,
    );
    expect(messageOf(failed)).toContain("Could not complete");
    expect(await t.db.select().from(integrationAccount)).toHaveLength(0);
  });

  test("disconnect stops the channel, removes imported blocks and wipes tokens", async () => {
    await seedAccount(t.db, seed.businessId, "google", {
      syncState: {
        calendarId: "primary",
        channel: { id: "ch", resourceId: "res", expiration: "2027-01-01T00:00:00Z" },
      },
    });
    await t.db.insert(timeBlock).values([
      {
        staffId: seed.staffId,
        during: { start: new Date("2026-12-01T00:00:00Z"), end: new Date("2026-12-01T01:00:00Z") },
        source: "google",
        externalId: "g1",
      },
      {
        staffId: seed.staffId,
        during: { start: new Date("2026-12-02T00:00:00Z"), end: new Date("2026-12-02T01:00:00Z") },
        source: "manual",
      },
    ]);

    const res = await googleDisconnect(new Request("https://x.test", { method: "POST" }), deps);
    expect(res.status).toBe(200);
    expect(google.calls.some((c) => c.method === "stop")).toBe(true);
    const [acc] = await t.db.select().from(integrationAccount);
    expect(acc.status).toBe("disconnected");
    expect(acc.encryptedTokens).toBeNull();
    const blocks = await t.db.select().from(timeBlock);
    expect(blocks.map((b) => b.source)).toEqual(["manual"]);
  });

  test("disconnect when never connected is a harmless no-op", async () => {
    const res = await googleDisconnect(new Request("https://x.test", { method: "POST" }), deps);
    expect(res.status).toBe(200);
  });

  test("webhook: a genuine push responds 204 and syncs after the response; a forged one does nothing", async () => {
    await seedAccount(t.db, seed.businessId, "google");
    await ensureWatchChannel(deps);
    const channelId = google.watches[0].channelId;
    const push = (token: string) =>
      googleWebhook(
        new Request("https://x.test/hook", {
          method: "POST",
          headers: {
            "x-goog-channel-id": channelId,
            "x-goog-channel-token": token,
            "x-goog-resource-state": "exists",
            "x-goog-message-number": "5",
          },
        }),
        deps,
      );

    expect((await push("forged")).status).toBe(403);
    expect(afterTasks).toHaveLength(0);

    expect((await push(deriveChannelToken(TEST_KEY, channelId))).status).toBe(200);
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(google.listParams).toHaveLength(1);

    // A sync that blows up must not escape the after() task.
    google.listResponses.push(new Error("google down"));
    await t.db.update(integrationAccount).set({
      syncState: {
        calendarId: "primary",
        channel: { id: channelId, resourceId: "r", expiration: "2027-01-01T00:00:00Z" },
      },
    });
    await googleWebhook(
      new Request("https://x.test/hook", {
        method: "POST",
        headers: {
          "x-goog-channel-id": channelId,
          "x-goog-channel-token": deriveChannelToken(TEST_KEY, channelId),
          "x-goog-resource-state": "exists",
          "x-goog-message-number": "6",
        },
      }),
      deps,
    );
    await expect(afterTasks[1]()).resolves.toBeUndefined();
  });
});
