import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The real SDK clients are created lazily. These tests stub the packages to check the wiring
 * (credentials, scopes, PKCE, token plumbing) without any network access.
 */

const googleState = vi.hoisted(() => ({
  oauth: undefined as undefined | Record<string, unknown>,
  listeners: {} as Record<string, (t: unknown) => void>,
  authUrlArgs: undefined as undefined | Record<string, unknown>,
  getTokenArgs: undefined as undefined | Record<string, unknown>,
  getTokenResult: {} as Record<string, unknown>,
  getTokenError: undefined as undefined | unknown,
}));

vi.mock("googleapis", () => {
  class OAuth2 {
    constructor(
      public clientId: string,
      public clientSecret: string,
      public redirect?: string,
    ) {}
    credentials: unknown;
    setCredentials(c: unknown) {
      this.credentials = c;
      googleState.oauth = { clientId: this.clientId, credentials: c };
    }
    on(event: string, cb: (t: unknown) => void) {
      googleState.listeners[event] = cb;
    }
    generateAuthUrl(args: Record<string, unknown>) {
      googleState.authUrlArgs = args;
      return "https://accounts.google.com/o/oauth2/v2/auth?x=1";
    }
    async getToken(args: Record<string, unknown>) {
      googleState.getTokenArgs = args;
      if (googleState.getTokenError) throw googleState.getTokenError;
      return { tokens: googleState.getTokenResult };
    }
  }
  return {
    google: {
      auth: { OAuth2 },
      calendar: () => ({ events: {}, channels: {} }),
    },
  };
});

const xeroState = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown> | undefined>,
  tokenSet: undefined as undefined | Record<string, unknown>,
  refreshError: undefined as undefined | unknown,
  tenants: [] as Array<Record<string, string>>,
}));

vi.mock("xero-node", () => {
  class XeroClient {
    accountingApi = {};
    constructor(config?: Record<string, unknown>) {
      xeroState.configs.push(config);
    }
    setTokenSet(set: Record<string, unknown>) {
      xeroState.tokenSet = set;
    }
    async buildConsentUrl() {
      return "https://login.xero.com/identity/connect/authorize";
    }
    async apiCallback(url: string) {
      void url;
      return { access_token: "a", refresh_token: "r", expires_at: 1000 };
    }
    async updateTenants() {
      return xeroState.tenants;
    }
    async refreshWithRefreshToken() {
      if (xeroState.refreshError) throw xeroState.refreshError;
      return { access_token: "na", refresh_token: "nr", expires_in: 1800 };
    }
  }
  return { XeroClient };
});

import {
  createGoogleAuthPort,
  createGoogleCalendarPort,
  GOOGLE_SCOPES,
} from "@/server/integrations/google/adapter";
import { createXeroAuthPort, createXeroPort } from "@/server/integrations/xero/adapter";
import { AuthRevokedError } from "@/server/integrations/common/errors";
import { XERO_SCOPES } from "@/server/integrations/xero/port";

describe("google SDK wiring", () => {
  beforeEach(() => {
    googleState.getTokenError = undefined;
    googleState.getTokenResult = {};
  });

  test("auth URL asks for offline access, consent, the narrow scope and a PKCE S256 challenge", async () => {
    const port = createGoogleAuthPort({ clientId: "id", clientSecret: "secret" });
    const url = await port.buildAuthUrl({
      state: "s",
      codeChallenge: "cc",
      redirectUri: "https://x/cb",
    });
    expect(url).toContain("accounts.google.com");
    expect(googleState.authUrlArgs).toMatchObject({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state: "s",
      code_challenge: "cc",
      code_challenge_method: "S256",
    });
    expect(GOOGLE_SCOPES).toEqual(["https://www.googleapis.com/auth/calendar.events"]);
  });

  test("code exchange sends the PKCE verifier and maps the tokens", async () => {
    googleState.getTokenResult = {
      access_token: "at",
      refresh_token: "rt",
      expiry_date: 123,
      scope: "s",
    };
    const port = createGoogleAuthPort({ clientId: "id", clientSecret: "secret" });
    expect(
      await port.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://x/cb" }),
    ).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: 123,
      scope: "s",
    });
    expect(googleState.getTokenArgs).toEqual({
      code: "c",
      codeVerifier: "v",
      redirect_uri: "https://x/cb",
    });

    googleState.getTokenResult = {};
    expect(await port.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "r" })).toEqual({
      accessToken: undefined,
      refreshToken: undefined,
      expiryDate: undefined,
      scope: undefined,
    });
  });

  test("a rejected code exchange is translated (invalid_grant means reconnect)", async () => {
    googleState.getTokenError = { message: "invalid_grant" };
    const port = createGoogleAuthPort({ clientId: "id", clientSecret: "secret" });
    await expect(
      port.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "r" }),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  test("the calendar port loads stored credentials and reports refreshed tokens", async () => {
    const seen: unknown[] = [];
    const port = await createGoogleCalendarPort({
      clientId: "id",
      clientSecret: "secret",
      tokens: { accessToken: "a", refreshToken: "r", expiryDate: 5 },
      onTokens: (t) => void seen.push(t),
    });
    expect(typeof port.insertEvent).toBe("function");
    expect(googleState.oauth).toMatchObject({
      credentials: { access_token: "a", refresh_token: "r", expiry_date: 5 },
    });
    googleState.listeners.tokens({ access_token: "fresh", expiry_date: 9 });
    googleState.listeners.tokens({ refresh_token: "newer" });
    expect(seen).toEqual([
      { accessToken: "fresh", refreshToken: undefined, expiryDate: 9 },
      { accessToken: undefined, refreshToken: "newer", expiryDate: undefined },
    ]);
  });
});

describe("xero SDK wiring", () => {
  beforeEach(() => {
    xeroState.configs.length = 0;
    xeroState.refreshError = undefined;
    xeroState.tenants = [];
  });

  test("the accounting port is bound to the access token", async () => {
    const port = await createXeroPort({ tenantId: "t", accessToken: "tok" });
    expect(typeof port.createInvoice).toBe("function");
    expect(xeroState.tokenSet).toEqual({ access_token: "tok" });
  });

  test("consent URL uses the granular scopes, the redirect URI and our state", async () => {
    const port = createXeroAuthPort({ clientId: "id", clientSecret: "secret" });
    expect(await port.buildConsentUrl({ state: "st", redirectUri: "https://x/cb" })).toContain(
      "xero.com",
    );
    expect(xeroState.configs[0]).toEqual({
      clientId: "id",
      clientSecret: "secret",
      redirectUris: ["https://x/cb"],
      scopes: [...XERO_SCOPES],
      state: "st",
    });
    expect(XERO_SCOPES).toEqual([
      "offline_access",
      "accounting.contacts",
      "accounting.invoices",
      "accounting.payments",
      "accounting.settings.read",
    ]);
  });

  test("callback exchange returns tokens and only organisation tenants", async () => {
    xeroState.tenants = [
      { tenantId: "o1", tenantName: "Demo", tenantType: "ORGANISATION" },
      { tenantId: "p1", tenantName: "Practice", tenantType: "PRACTICE" },
      { tenantId: "o2", tenantType: "ORGANISATION" },
    ];
    const port = createXeroAuthPort({ clientId: "id", clientSecret: "secret" });
    const result = await port.exchangeCallback({
      callbackUrl: "https://x/cb?code=1",
      state: "st",
      redirectUri: "https://x/cb",
    });
    expect(result.tokens).toMatchObject({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_000_000,
    });
    expect(result.tenants).toEqual([
      { tenantId: "o1", tenantName: "Demo" },
      { tenantId: "o2", tenantName: "" },
    ]);
  });

  test("refresh returns the rotated pair; a refused refresh means reconnect", async () => {
    const port = createXeroAuthPort({ clientId: "id", clientSecret: "secret" });
    expect(await port.refresh("old")).toMatchObject({ accessToken: "na", refreshToken: "nr" });
    // The refresh client is built without OAuth redirect config.
    expect(xeroState.configs.at(-1)).toEqual({ clientId: "id", clientSecret: "secret" });

    xeroState.refreshError = { response: { status: 400, data: { error: "invalid_grant" } } };
    await expect(port.refresh("old")).rejects.toBeInstanceOf(AuthRevokedError);
  });
});
