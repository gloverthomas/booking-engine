import { describe, expect, test } from "vitest";
import {
  evaluateIdentity,
  isOwnerEmail,
  loginErrorMessage,
  parseOwnerEmails,
  NOT_AUTHORISED_CODE,
} from "@/server/auth/owners";

describe("parseOwnerEmails", () => {
  test("splits on commas, trims, lowercases and drops blanks", () => {
    const set = parseOwnerEmails(" Ryan@Example.com, ,second@example.com ,, ");
    expect([...set].sort()).toEqual(["ryan@example.com", "second@example.com"]);
  });

  test("returns an empty set when unset so nobody is allowed (fail closed)", () => {
    expect(parseOwnerEmails(undefined).size).toBe(0);
    expect(parseOwnerEmails("").size).toBe(0);
    expect(parseOwnerEmails("   ,  ").size).toBe(0);
  });
});

describe("isOwnerEmail", () => {
  const owners = parseOwnerEmails("ryan@example.com");

  test("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isOwnerEmail("RYAN@example.com", owners)).toBe(true);
    expect(isOwnerEmail("  ryan@example.com ", owners)).toBe(true);
  });

  test("rejects other, missing and look-alike addresses", () => {
    expect(isOwnerEmail("stranger@example.com", owners)).toBe(false);
    expect(isOwnerEmail("ryan@example.com.evil.test", owners)).toBe(false);
    expect(isOwnerEmail("evil+ryan@example.com", owners)).toBe(false);
    expect(isOwnerEmail(null, owners)).toBe(false);
    expect(isOwnerEmail(undefined, owners)).toBe(false);
    expect(isOwnerEmail("", owners)).toBe(false);
  });

  test("rejects everyone when the allow-list is empty", () => {
    expect(isOwnerEmail("ryan@example.com", parseOwnerEmails(undefined))).toBe(false);
  });
});

describe("evaluateIdentity", () => {
  const owners = parseOwnerEmails("ryan@example.com");

  test("admits an allow-listed, verified address", () => {
    expect(evaluateIdentity({ email: "ryan@example.com", emailVerified: true }, owners)).toBeNull();
  });

  test("admits when the provider does not state verification (Google always does)", () => {
    expect(evaluateIdentity({ email: "ryan@example.com" }, owners)).toBeNull();
  });

  test("rejects addresses not on the allow-list with a clear, non-sensitive reason", () => {
    const result = evaluateIdentity({ email: "x@example.com", emailVerified: true }, owners);
    expect(result).toEqual({
      error: NOT_AUTHORISED_CODE,
      errorDescription: expect.stringMatching(/not authori[sz]ed/i),
    });
  });

  test("rejects an allow-listed address the provider says is unverified", () => {
    const result = evaluateIdentity({ email: "ryan@example.com", emailVerified: false }, owners);
    expect(result?.error).toBe("email_not_verified");
  });

  test("rejects a missing email", () => {
    expect(evaluateIdentity({}, owners)?.error).toBe(NOT_AUTHORISED_CODE);
  });
});

describe("loginErrorMessage", () => {
  test("explains the not-authorised case in plain English", () => {
    expect(loginErrorMessage(NOT_AUTHORISED_CODE)).toMatch(/not authori[sz]ed/i);
  });

  test("handles the unverified and generic cases and ignores empty codes", () => {
    expect(loginErrorMessage("email_not_verified")).toMatch(/verified/i);
    expect(loginErrorMessage("access_denied")).toMatch(/cancelled|denied/i);
    expect(loginErrorMessage("something_else")).toMatch(/couldn.t sign you in/i);
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("")).toBeNull();
  });
});
