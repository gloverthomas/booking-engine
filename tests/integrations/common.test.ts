import { beforeEach, describe, expect, test } from "vitest";
import {
  googleCredentials,
  isHttps,
  redirectUri,
  requireAppUrl,
  requireEncryptionKey,
  xeroCredentials,
} from "@/server/integrations/common/env";
import {
  AuthRevokedError,
  errorMessage,
  NotConfiguredError,
  NotConnectedError,
  ProviderValidationError,
  RateLimitedError,
  TransientProviderError,
  isRetryable,
} from "@/server/integrations/common/errors";
import {
  clearOAuthCookie,
  jsonResponse,
  redirectResponse,
  settingsRedirect,
} from "@/server/integrations/common/http";
import { withBackoff, withRateLimitRetry } from "@/server/integrations/common/retry";
import { testEnv } from "./helpers";

describe("env access", () => {
  test("fails clearly, and only when the key is actually needed", () => {
    const empty = testEnv({
      APP_URL: undefined,
      ENCRYPTION_KEY: undefined,
      GOOGLE_CLIENT_ID: undefined,
      XERO_CLIENT_SECRET: undefined,
    });
    expect(() => requireEncryptionKey(empty)).toThrow(/ENCRYPTION_KEY is not set/);
    expect(() => requireAppUrl(empty)).toThrow(/APP_URL is not set/);
    expect(() => googleCredentials(empty)).toThrow(NotConfiguredError);
    expect(() => xeroCredentials(empty)).toThrow(/XERO_CLIENT_SECRET/);
    expect(() => googleCredentials(testEnv({ GOOGLE_CLIENT_SECRET: undefined }))).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
    expect(() => xeroCredentials(testEnv({ XERO_CLIENT_ID: undefined }))).toThrow(/XERO_CLIENT_ID/);
  });

  test("builds the exact redirect URIs to register", () => {
    const env = testEnv({ APP_URL: "https://book.example.com/" });
    expect(requireAppUrl(env)).toBe("https://book.example.com");
    expect(redirectUri(env, "google")).toBe(
      "https://book.example.com/api/integrations/google/callback",
    );
    expect(redirectUri(env, "xero")).toBe(
      "https://book.example.com/api/integrations/xero/callback",
    );
    expect(googleCredentials(env)).toEqual({
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    expect(xeroCredentials(env)).toEqual({ clientId: "xero-client", clientSecret: "xero-secret" });
    expect(isHttps("https://x")).toBe(true);
    expect(isHttps("http://localhost")).toBe(false);
  });
});

describe("error taxonomy", () => {
  test("only things a person must fix are non-retryable", () => {
    expect(isRetryable(new TransientProviderError("x"))).toBe(true);
    expect(isRetryable(new RateLimitedError("x", 1))).toBe(true);
    expect(isRetryable(new Error("unknown"))).toBe(true);
    expect(isRetryable(new AuthRevokedError("x"))).toBe(false);
    expect(isRetryable(new ProviderValidationError("x"))).toBe(false);
    expect(isRetryable(new NotConfiguredError("x"))).toBe(false);
    expect(isRetryable(new NotConnectedError("x"))).toBe(false);
  });

  test("error names and messages", () => {
    expect(new AuthRevokedError("x").name).toBe("AuthRevokedError");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("nope")).toBe("Unknown error");
  });
});

describe("rate limit retry", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  beforeEach(() => {
    sleeps.length = 0;
  });

  test("waits Retry-After then retries", async () => {
    let n = 0;
    const result = await withRateLimitRetry(
      async () => {
        n += 1;
        if (n < 3) throw new RateLimitedError("429", 4);
        return "ok";
      },
      { sleep },
    );
    expect(result).toBe("ok");
    expect(sleeps).toEqual([4000, 4000]);
  });

  test("gives up after the attempt limit, and never sleeps on a long wait or another error", async () => {
    await expect(
      withRateLimitRetry(async () => Promise.reject(new RateLimitedError("429", 1)), {
        sleep,
        attempts: 2,
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(sleeps).toEqual([1000]);

    sleeps.length = 0;
    await expect(
      withRateLimitRetry(async () => Promise.reject(new RateLimitedError("day", 7200)), { sleep }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      withRateLimitRetry(async () => Promise.reject(new Error("other")), { sleep }),
    ).rejects.toThrow("other");
    expect(sleeps).toEqual([]);
  });

  test("withBackoff wraps every method and keeps `this`", async () => {
    class Thing {
      calls = 0;
      async work(x: number): Promise<number> {
        this.calls += 1;
        if (this.calls === 1) throw new RateLimitedError("429", 1);
        return x * 2;
      }
    }
    const thing = new Thing();
    // Methods live on the prototype, so wrap an object literal over them as the adapters are.
    const port = withBackoff({ work: (x: number) => thing.work(x) }, { sleep });
    expect(await port.work(21)).toBe(42);
  });
});

describe("http helpers", () => {
  test("redirects carry every cookie; json is never cached", async () => {
    const res = redirectResponse("https://x.test/a", ["a=1", "b=2"]);
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jsonResponse({ ok: 1 }, 201).status).toBe(201);
    expect(jsonResponse({}).headers.get("cache-control")).toBe("no-store");
  });

  test("settings redirects carry only the outcome", () => {
    const ok = settingsRedirect("https://x.test", "xero", { ok: true }, []);
    expect(ok.headers.get("location")).toBe(
      "https://x.test/settings?integration=xero&status=connected",
    );
    const bad = settingsRedirect("https://x.test", "google", { ok: false, message: "No" }, []);
    expect(bad.headers.get("location")).toContain("status=error&message=No");
    expect(clearOAuthCookie("google", false)).toMatch(/Max-Age=0/);
  });
});
