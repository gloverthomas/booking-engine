import { beforeEach, describe, expect, test, vi } from "vitest";
import { integrationAccount } from "@/db/schema";
import { decryptJson } from "@/server/crypto";
import { getIntegrationStatuses } from "@/server/integrations/common/status";
import {
  xeroCallback,
  xeroConnect,
  xeroDisconnect,
  xeroGetConfig,
  xeroListAccounts,
  xeroUpdateConfig,
  type XeroRouteDeps,
} from "@/server/integrations/xero/routes";
import type { XeroTokens } from "@/server/integrations/xero/port";
import { createTestDb } from "../../helpers/test-db";
import { setupTestDb } from "../helpers";
import { seedAccount, seedBooking, TEST_KEY, type BookingSeed } from "../helpers";
import { fakeXero, fakeXeroAuth, seedXero, xeroDeps, type FakeXero } from "../xero-helpers";

const shared = setupTestDb();

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const messageOf = (res: Response): string =>
  new URL(res.headers.get("location")!).searchParams.get("message") ?? "";

describe("xero routes", () => {
  let t: TestDb;
  let seed: BookingSeed;
  let xero: FakeXero;
  let auth: ReturnType<typeof fakeXeroAuth>;
  let afterTasks: Array<() => Promise<void>>;
  let requireOwner: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  let deps: XeroRouteDeps;

  beforeEach(async () => {
    t = shared.current;
    seed = await seedBooking(t.db);
    xero = fakeXero();
    auth = fakeXeroAuth();
    afterTasks = [];
    requireOwner = vi.fn<() => Promise<unknown>>(async () => ({ userId: "u1" }));
    deps = {
      ...xeroDeps(t.db, xero, { authPort: auth }),
      requireOwner,
      runAfter: (task) => afterTasks.push(task),
    };
  });
  async function startConnect() {
    const res = await xeroConnect(
      new Request("https://book.example.com/api/integrations/xero/connect"),
      deps,
    );
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    return { res, state, cookie: res.headers.get("set-cookie")!.split(";")[0] };
  }
  const callbackReq = (qs: string, cookie?: string) =>
    new Request(`http://internal:3000/api/integrations/xero/callback?${qs}`, {
      headers: cookie ? { cookie } : {},
    });
  const req = (method: string, body?: unknown) =>
    new Request("https://x.test/api", {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("connect requires the owner, sets the state cookie and redirects to Xero's consent page", async () => {
    const { res, state } = await startConnect();
    expect(requireOwner).toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("login.xero.com");
    expect(state.length).toBeGreaterThan(20);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/integrations\/xero/);
    expect(auth.buildConsentUrl).toHaveBeenCalledWith({
      state,
      redirectUri: "https://book.example.com/api/integrations/xero/callback",
    });
  });

  test("callback stores encrypted tokens and the tenant, keeps earlier account settings, and reconciles afterwards", async () => {
    await seedXero(t.db, seed.businessId, { clearingAccountCode: "777" });
    await t.db.update(integrationAccount).set({ status: "disconnected" });
    const { state, cookie } = await startConnect();

    const res = await xeroCallback(callbackReq(`code=abc&state=${state}`, cookie), deps);

    expect(res.headers.get("location")).toContain("status=connected");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    // The SDK gets the public callback URL, not the proxy-internal one.
    expect(auth.exchangeCallback).toHaveBeenCalledWith({
      callbackUrl: `https://book.example.com/api/integrations/xero/callback?code=abc&state=${state}`,
      state,
      redirectUri: "https://book.example.com/api/integrations/xero/callback",
    });
    const [acc] = await t.db.select().from(integrationAccount);
    expect(acc.status).toBe("connected");
    expect(acc.externalAccountId).toBe("tenant-9");
    expect(acc.syncState).toMatchObject({
      clearingAccountCode: "777",
      tenantName: "Demo Company (AU)",
    });
    expect(acc.encryptedTokens).not.toContain("xrt");
    expect(decryptJson<XeroTokens>(acc.encryptedTokens!, TEST_KEY).refreshToken).toBe("xrt");

    await afterTasks[0]();
    expect(xero.count("createInvoice")).toBe(1); // the seeded confirmed booking is picked up
  });

  test("a failing post-connect reconcile is logged, not thrown", async () => {
    const { state, cookie } = await startConnect();
    await xeroCallback(callbackReq(`code=abc&state=${state}`, cookie), deps);
    xero.failures.createContact = [new Error("xero down")];
    await expect(afterTasks[0]()).resolves.toBeUndefined();
  });

  test("callback rejects forged state, missing cookie, user denial and a missing organisation", async () => {
    const { state, cookie } = await startConnect();
    expect(
      (await xeroCallback(callbackReq("code=abc&state=attacker", cookie), deps)).headers.get(
        "location",
      ),
    ).toContain("status=error");
    expect(
      (await xeroCallback(callbackReq(`code=abc&state=${state}`), deps)).headers.get("location"),
    ).toContain("status=error");
    expect(messageOf(await xeroCallback(callbackReq("error=access_denied", cookie), deps))).toMatch(
      /cancelled or denied/,
    );
    expect(auth.exchangeCallback).not.toHaveBeenCalled();

    auth.exchangeCallback.mockResolvedValueOnce({
      tokens: { accessToken: "a", refreshToken: "r", expiresAt: 1 },
      tenants: [],
    });
    const noTenant = await xeroCallback(callbackReq(`code=abc&state=${state}`, cookie), deps);
    expect(messageOf(noTenant)).toMatch(/No Xero organisation/);
    expect(await t.db.select().from(integrationAccount)).toHaveLength(0);
  });

  test("callback turns an exchange failure into an error redirect", async () => {
    const { state, cookie } = await startConnect();
    auth.exchangeCallback.mockRejectedValueOnce(new Error("boom"));
    const res = await xeroCallback(callbackReq(`code=abc&state=${state}`, cookie), deps);
    expect(messageOf(res)).toMatch(/Could not complete/);
  });

  test("disconnect wipes tokens but keeps the accounting settings", async () => {
    await seedXero(t.db, seed.businessId);
    const res = await xeroDisconnect(req("POST"), deps);
    expect(res.status).toBe(200);
    const [acc] = await t.db.select().from(integrationAccount);
    expect(acc).toMatchObject({ status: "disconnected", encryptedTokens: null });
    expect(acc.syncState.clearingAccountCode).toBe("610");
  });

  describe("config", () => {
    test("GET returns defaults when not connected and the stored values when connected", async () => {
      const empty = await (await xeroGetConfig(req("GET"), deps)).json();
      expect(empty.config).toMatchObject({
        revenueAccountCode: "200",
        taxType: "NONE",
        writeOffOnCancel: true,
      });
      await seedXero(t.db, seed.businessId);
      const full = await (await xeroGetConfig(req("GET"), deps)).json();
      expect(full.config.clearingAccountCode).toBe("610");
    });

    test("PATCH validates and merges only the given keys; null clears a code", async () => {
      await seedXero(t.db, seed.businessId);
      const ok = await xeroUpdateConfig(
        req("PATCH", { taxType: "OUTPUT", cashAccountCode: null, revenueAccountCode: "260" }),
        deps,
      );
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.config).toMatchObject({
        taxType: "OUTPUT",
        revenueAccountCode: "260",
        clearingAccountCode: "610",
      });
      expect(body.config.cashAccountCode).toBeUndefined();
    });

    test("PATCH rejects unknown keys, bad values and bad JSON; and needs a connection", async () => {
      expect((await xeroUpdateConfig(req("PATCH", { taxType: "OUTPUT" }), deps)).status).toBe(409);
      await seedXero(t.db, seed.businessId);
      expect((await xeroUpdateConfig(req("PATCH", { taxType: "VAT" }), deps)).status).toBe(400);
      expect((await xeroUpdateConfig(req("PATCH", { tokens: "x" }), deps)).status).toBe(400);
      expect(
        (
          await xeroUpdateConfig(
            new Request("https://x.test", { method: "PATCH", body: "not json" }),
            deps,
          )
        ).status,
      ).toBe(400);
    });
  });

  describe("accounts", () => {
    test("lists only active accounts", async () => {
      await seedXero(t.db, seed.businessId);
      xero.accounts = [
        { code: "200", name: "Sales", type: "REVENUE", status: "ACTIVE", enablePayments: false },
        { code: "999", name: "Old", type: "REVENUE", status: "ARCHIVED", enablePayments: false },
      ];
      const body = await (await xeroListAccounts(req("GET"), deps)).json();
      expect(body.accounts.map((a: { code: string }) => a.code)).toEqual(["200"]);
    });

    test("409 when not connected, 502 when Xero fails", async () => {
      expect((await xeroListAccounts(req("GET"), deps)).status).toBe(409);
      await seedXero(t.db, seed.businessId);
      xero.failures.listAccounts = [new Error("down")];
      expect((await xeroListAccounts(req("GET"), deps)).status).toBe(502);
    });
  });

  test("every route enforces the owner guard", async () => {
    requireOwner.mockRejectedValue(new Error("not signed in"));
    for (const call of [
      xeroConnect,
      xeroCallback,
      xeroDisconnect,
      xeroGetConfig,
      xeroUpdateConfig,
      xeroListAccounts,
    ]) {
      await expect(call(req("GET"), deps)).rejects.toThrow("not signed in");
    }
  });
});

describe("integration status", () => {
  test("reports not set up, connected with target, and error as needing reconnect", async () => {
    const t = shared.current;
    const seed = await seedBooking(t.db);
    expect((await getIntegrationStatuses(t.db)).map((s) => s.status)).toEqual([
      "not_set_up",
      "not_set_up",
    ]);

    await seedAccount(t.db, seed.businessId, "google", {
      syncState: { calendarId: "work@example.com" },
    });
    await seedXero(t.db, seed.businessId);
    await t.db
      .update(integrationAccount)
      .set({ status: "error", lastError: "Reconnect Xero" })
      .where((await import("drizzle-orm")).eq(integrationAccount.provider, "xero"));

    const [google, xero] = await getIntegrationStatuses(t.db);
    expect(google).toMatchObject({
      status: "connected",
      needsReconnect: false,
      target: "work@example.com",
    });
    expect(xero).toMatchObject({
      status: "error",
      needsReconnect: true,
      lastError: "Reconnect Xero",
      target: "Ryan Kennedy Hairdressing",
    });
    expect(JSON.stringify([google, xero])).not.toContain("encryptedTokens");
  });
});
