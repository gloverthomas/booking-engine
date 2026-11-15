import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { createStaff, seedBasics } from "../helpers/factories";
import { integrationAccount } from "@/db/schema";
import {
  configuredProvidersFromEnv,
  getIntegrationCards,
  listGoogleByStylist,
} from "@/server/admin-foundation/integrations";
import { parseEnv } from "@/lib/env";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/x" };

describe("configuredProvidersFromEnv", () => {
  test("reports which providers have their keys set", () => {
    expect(configuredProvidersFromEnv(parseEnv(base))).toEqual({
      stripe: false,
      google: false,
      xero: false,
    });
    expect(
      configuredProvidersFromEnv(
        parseEnv({
          ...base,
          STRIPE_SECRET_KEY: "sk_test_x",
          GOOGLE_CLIENT_ID: "a",
          GOOGLE_CLIENT_SECRET: "b",
          XERO_CLIENT_ID: "c",
        }),
      ),
    ).toEqual({ stripe: true, google: true, xero: false });
  });
});

describe("getIntegrationCards", () => {
  let h: Awaited<ReturnType<typeof createTestDb>>;
  let businessId: string;
  beforeEach(async () => {
    h = await createTestDb();
    businessId = (await seedBasics(h.db)).biz.id;
  });
  afterEach(async () => {
    await h.client.close();
  });

  test("always returns Stripe, Google and Xero in that order, disconnected when there is no row", async () => {
    const cards = await getIntegrationCards(h.db, { stripe: true, google: true, xero: true });
    expect(cards.map((c) => c.provider)).toEqual(["stripe", "google", "xero"]);
    const google = cards.find((c) => c.provider === "google");
    expect(google).toMatchObject({
      status: "disconnected",
      connectHref: null, // Google is linked per stylist, from the Staff and Integrations pages
      lastSyncAt: null,
      lastError: null,
    });
    expect(cards.find((c) => c.provider === "xero")?.connectHref).toBe(
      "/api/integrations/xero/connect",
    );
  });

  test("Stripe is configured by API keys, so it has no connect link and reads as connected", async () => {
    const [stripe] = await getIntegrationCards(h.db, { stripe: true, google: false, xero: false });
    expect(stripe).toMatchObject({ provider: "stripe", status: "connected", connectHref: null });
  });

  test("shows 'not configured' when the provider's keys are missing", async () => {
    const cards = await getIntegrationCards(h.db, { stripe: false, google: false, xero: false });
    expect(cards.every((c) => c.status === "not_configured")).toBe(true);
    expect(cards.find((c) => c.provider === "google")?.connectHref).toBeNull();
  });

  test("surfaces status, account, last sync and last error from integration_account", async () => {
    const lastSyncAt = new Date("2030-01-01T00:00:00Z");
    const { stylist } = await seedBasics(h.db);
    await h.db.insert(integrationAccount).values([
      {
        businessId,
        staffId: stylist.id,
        provider: "google",
        status: "connected",
        externalAccountId: "ryan@example.com",
        lastSyncAt,
      },
      {
        businessId,
        provider: "xero",
        status: "error",
        externalAccountId: "Ryan Kennedy Hair",
        lastError: "Token refresh failed",
      },
    ]);
    const cards = await getIntegrationCards(h.db, { stripe: true, google: true, xero: true });
    expect(cards.find((c) => c.provider === "google")).toMatchObject({
      status: "connected",
      lastSyncAt,
    });
    expect(cards.find((c) => c.provider === "xero")).toMatchObject({
      status: "error",
      lastError: "Token refresh failed",
    });
  });

  test("never exposes tokens", async () => {
    await h.db.insert(integrationAccount).values({
      businessId,
      provider: "xero",
      status: "connected",
      encryptedTokens: "ciphertext",
    });
    const cards = await getIntegrationCards(h.db, { stripe: true, google: true, xero: true });
    expect(JSON.stringify(cards)).not.toContain("ciphertext");
  });

  test("the Google card rolls up the stylists: errors win, then connected, and Xero is unaffected", async () => {
    const a = await createStaff(h.db, businessId, { name: "A", email: "a@example.com" });
    const b = await createStaff(h.db, businessId, { name: "B", email: "b@example.com" });
    await h.db.insert(integrationAccount).values([
      { businessId, staffId: a.id, provider: "google", status: "connected" },
      { businessId, staffId: b.id, provider: "google", status: "error", lastError: "Revoked" },
    ]);
    const cards = await getIntegrationCards(h.db, { stripe: true, google: true, xero: true });
    expect(cards.find((c) => c.provider === "google")).toMatchObject({
      status: "error",
      lastError: "Revoked",
    });
    expect(cards.find((c) => c.provider === "xero")?.status).toBe("disconnected");
  });

  test("listGoogleByStylist returns active people only, with their own link status", async () => {
    const a = await createStaff(h.db, businessId, { name: "A", email: "a@example.com" });
    await createStaff(h.db, businessId, { name: "Gone", email: "g@example.com", active: false });
    await h.db
      .insert(integrationAccount)
      .values({ businessId, staffId: a.id, provider: "google", status: "connected" });
    const people = await listGoogleByStylist(h.db);
    expect(people.map((p) => p.name)).toEqual(["A", "Ryan"]);
    expect(people[0].google?.status).toBe("connected");
    expect(people[1].google).toBeNull();
  });
});
