import { beforeEach, describe, expect, test } from "vitest";
import { integrationAccount } from "@/db/schema";
import { decryptJson } from "@/server/crypto";
import {
  AuthRevokedError,
  NotConfiguredError,
  NotConnectedError,
  TransientProviderError,
} from "@/server/integrations/common/errors";
import { getXeroAccessToken, loadXeroRuntime } from "@/server/integrations/xero/runtime";
import type { XeroTokens } from "@/server/integrations/xero/port";
import { runXeroKeepalive } from "@/server/integrations/xero/jobs";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import { NOW, seedBooking, testEnv, TEST_KEY, type BookingSeed } from "../helpers";
import { fakeXero, fakeXeroAuth, seedXero, xeroDeps, xeroTokens } from "../xero-helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("Xero token handling (rotating, single-use refresh tokens)", () => {
  let t: TestDb;
  let seed: BookingSeed;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
  });
  const stored = async () => {
    const [acc] = await t.db.select().from(integrationAccount);
    return { acc, tokens: decryptJson<XeroTokens>(acc.encryptedTokens!, TEST_KEY) };
  };

  test("a still-valid access token is used as is: no refresh", async () => {
    await seedXero(t.db, seed.businessId);
    const auth = fakeXeroAuth();
    const deps = xeroDeps(t.db, fakeXero(), { authPort: auth });
    expect((await getXeroAccessToken(deps)).accessToken).toBe("xat");
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  test("an expiring token is refreshed and the NEW token pair is stored before use", async () => {
    await seedXero(t.db, seed.businessId, {}, xeroTokens({ expiresAt: NOW.getTime() + 10_000 }));
    const auth = fakeXeroAuth();
    const deps = xeroDeps(t.db, fakeXero(), { authPort: auth });

    const result = await getXeroAccessToken(deps);

    expect(auth.refresh).toHaveBeenCalledWith("xrt");
    expect(result.accessToken).toBe("new-at-1");
    const { acc, tokens } = await stored();
    expect(tokens).toMatchObject({ accessToken: "new-at-1", refreshToken: "new-rt-1" });
    expect(acc.syncState.lastTokenRefreshAt).toBe(NOW.toISOString());
    expect(acc.syncState.clearingAccountCode).toBe("610"); // config survives
  });

  test("concurrent callers refresh once: the second re-reads the rotated token after the lock", async () => {
    await seedXero(t.db, seed.businessId, {}, xeroTokens({ expiresAt: NOW.getTime() - 1 }));
    const auth = fakeXeroAuth();
    const deps = xeroDeps(t.db, fakeXero(), { authPort: auth });

    const [a, b] = await Promise.all([getXeroAccessToken(deps), getXeroAccessToken(deps)]);

    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("new-at-1");
    expect(b.accessToken).toBe("new-at-1");
  });

  test("force refreshes a fresh token (keepalive)", async () => {
    await seedXero(t.db, seed.businessId);
    const auth = fakeXeroAuth();
    await getXeroAccessToken(xeroDeps(t.db, fakeXero(), { authPort: auth }), { force: true });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  test("a refused refresh (invalid_grant) flips the account to 'error' and surfaces the reconnect message", async () => {
    await seedXero(t.db, seed.businessId, {}, xeroTokens({ expiresAt: NOW.getTime() - 1 }));
    const auth = fakeXeroAuth();
    auth.refresh.mockRejectedValueOnce(new AuthRevokedError("invalid_grant"));
    const deps = xeroDeps(t.db, fakeXero(), { authPort: auth });

    await expect(getXeroAccessToken(deps)).rejects.toBeInstanceOf(AuthRevokedError);

    const { acc, tokens } = await stored();
    expect(acc.status).toBe("error");
    expect(acc.lastError).toMatch(/Reconnect Xero/);
    // The old token is untouched, not replaced by garbage.
    expect(tokens.refreshToken).toBe("xrt");
  });

  test("a transient refresh failure leaves the account connected and keeps the old token", async () => {
    await seedXero(t.db, seed.businessId, {}, xeroTokens({ expiresAt: NOW.getTime() - 1 }));
    const auth = fakeXeroAuth();
    auth.refresh.mockRejectedValueOnce(new TransientProviderError("identity.xero.com 503"));
    await expect(
      getXeroAccessToken(xeroDeps(t.db, fakeXero(), { authPort: auth })),
    ).rejects.toThrow("503");
    const { acc, tokens } = await stored();
    expect(acc.status).toBe("connected");
    expect(tokens.refreshToken).toBe("xrt");
  });

  test("not connected, no tokens, no tenant", async () => {
    const deps = xeroDeps(t.db, fakeXero());
    await expect(getXeroAccessToken(deps)).rejects.toBeInstanceOf(NotConnectedError);

    const acc = await seedXero(t.db, seed.businessId);
    await t.db.update(integrationAccount).set({ encryptedTokens: null });
    await expect(getXeroAccessToken(deps)).rejects.toBeInstanceOf(NotConnectedError);

    await t.db.update(integrationAccount).set({ status: "disconnected" });
    await expect(getXeroAccessToken(deps)).rejects.toBeInstanceOf(NotConnectedError);
    void acc;
  });

  test("a missing ENCRYPTION_KEY is a clear configuration error", async () => {
    await seedXero(t.db, seed.businessId);
    const deps = xeroDeps(t.db, fakeXero(), { env: testEnv({ ENCRYPTION_KEY: undefined }) });
    await expect(getXeroAccessToken(deps)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  test("loadXeroRuntime builds the port for the stored tenant with the parsed config", async () => {
    await seedXero(t.db, seed.businessId, { taxType: "OUTPUT" });
    let built: unknown;
    const deps = xeroDeps(t.db, fakeXero(), {
      createPort: async (input) => {
        built = input;
        return fakeXero();
      },
    });
    const runtime = await loadXeroRuntime(deps);
    expect(built).toEqual({ tenantId: "tenant-1", accessToken: "xat" });
    expect(runtime.config).toMatchObject({ taxType: "OUTPUT", revenueAccountCode: "200" });
  });

  test("a connected account with no tenant is not usable", async () => {
    await seedXero(t.db, seed.businessId);
    await t.db.update(integrationAccount).set({ externalAccountId: null });
    await expect(loadXeroRuntime(xeroDeps(t.db, fakeXero()))).rejects.toBeInstanceOf(
      NotConnectedError,
    );
  });

  describe("keepalive", () => {
    test("refreshes when the token has not been refreshed for a week, not before", async () => {
      await seedXero(t.db, seed.businessId, {
        lastTokenRefreshAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      });
      const auth = fakeXeroAuth();
      const deps = xeroDeps(t.db, fakeXero(), { authPort: auth });
      expect(await runXeroKeepalive(deps)).toBe(false);
      expect(auth.refresh).not.toHaveBeenCalled();

      await t.db.update(integrationAccount).set({
        syncState: {
          clearingAccountCode: "610",
          lastTokenRefreshAt: new Date(NOW.getTime() - 8 * 86_400_000).toISOString(),
        },
      });
      expect(await runXeroKeepalive(deps)).toBe(true);
      expect(auth.refresh).toHaveBeenCalledTimes(1);
    });

    test("refreshes when it has never been recorded; reports auth failure; ignores a disconnected account", async () => {
      await seedXero(t.db, seed.businessId);
      const auth = fakeXeroAuth();
      const deps = xeroDeps(t.db, fakeXero(), { authPort: auth });
      expect(await runXeroKeepalive(deps)).toBe(true);

      await t.db.update(integrationAccount).set({ syncState: {} });
      auth.refresh.mockRejectedValueOnce(new AuthRevokedError("invalid_grant"));
      expect(await runXeroKeepalive(deps)).toBe(false);
      expect((await t.db.select().from(integrationAccount))[0].status).toBe("error");

      expect(await runXeroKeepalive(deps)).toBe(false); // status error: skipped
    });
  });
});
