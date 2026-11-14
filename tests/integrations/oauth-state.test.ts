import { describe, expect, test } from "vitest";
import {
  beginOAuth,
  completeOAuth,
  OAuthStateError,
  oauthCookieName,
  pkceChallenge,
  readCookie,
  serializeCookie,
} from "@/server/integrations/common/oauth-state";
import { NOW, TEST_KEY } from "./helpers";

describe("OAuth state (CSRF + PKCE)", () => {
  test("round trip returns the verifier and extras", () => {
    const begun = beginOAuth({ provider: "google", key: TEST_KEY, now: NOW, extra: { a: "b" } });
    const txn = completeOAuth({
      provider: "google",
      key: TEST_KEY,
      now: NOW,
      cookieValue: begun.cookieValue,
      stateParam: begun.state,
    });
    expect(txn.codeVerifier).toBe(begun.codeVerifier);
    expect(txn.extra).toEqual({ a: "b" });
    expect(begun.codeChallenge).toBe(pkceChallenge(begun.codeVerifier));
    expect(begun.codeChallenge).not.toBe(begun.codeVerifier);
  });

  test("RFC 7636 test vector for the S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  const base = () => beginOAuth({ provider: "xero", key: TEST_KEY, now: NOW });
  const attempt = (over: Partial<Parameters<typeof completeOAuth>[0]>) => () =>
    completeOAuth({
      provider: "xero",
      key: TEST_KEY,
      now: NOW,
      cookieValue: undefined,
      stateParam: null,
      ...over,
    });

  test("rejects a missing cookie or state", () => {
    const begun = base();
    expect(attempt({ stateParam: begun.state })).toThrow(OAuthStateError);
    expect(attempt({ cookieValue: begun.cookieValue })).toThrow(OAuthStateError);
  });

  test("rejects a different state (CSRF)", () => {
    const begun = base();
    expect(attempt({ cookieValue: begun.cookieValue, stateParam: "attacker" })).toThrow(/mismatch/);
  });

  test("rejects a state of the same length but different content", () => {
    const begun = base();
    const forged = "x".repeat(begun.state.length);
    expect(attempt({ cookieValue: begun.cookieValue, stateParam: forged })).toThrow(/mismatch/);
  });

  test("rejects a cookie from another provider, a tampered cookie and an expired one", () => {
    const begun = base();
    expect(
      completeOAuth.bind(null, {
        provider: "google",
        key: TEST_KEY,
        now: NOW,
        cookieValue: begun.cookieValue,
        stateParam: begun.state,
      }),
    ).toThrow(/mismatch/);
    expect(attempt({ cookieValue: "garbage", stateParam: begun.state })).toThrow(/verified/);
    expect(
      attempt({
        cookieValue: begun.cookieValue,
        stateParam: begun.state,
        now: new Date(NOW.getTime() + 11 * 60_000),
      }),
    ).toThrow(/expired/);
  });
});

describe("cookies", () => {
  test("serialize and read back, Secure only when asked", () => {
    const header = serializeCookie("c", "a b=c", { maxAgeSec: 60, path: "/x", secure: true });
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    expect(serializeCookie("c", "v", { maxAgeSec: 1, path: "/", secure: false })).not.toContain(
      "Secure",
    );
    expect(readCookie("a=1; c=a%20b%3Dc", "c")).toBe("a b=c");
    expect(readCookie(null, "c")).toBeUndefined();
    expect(readCookie("a=1", "c")).toBeUndefined();
    expect(oauthCookieName("google")).toBe("be_oauth_google");
  });
});
