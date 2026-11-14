import { randomBytes } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  bearerAuthenticatorFromEnv,
  bearerTokenFrom,
  createBearerAuthenticator,
  hashToken,
} from "@/server/mcp/auth";
import { CONFIRM_TTL_MS, loadMcpConfig } from "@/server/mcp/config";
import { canonicalJson, createConfirmToken, verifyConfirmToken } from "@/server/mcp/confirm";
import { McpToolError, callBackend, toErrorBody } from "@/server/mcp/errors";
import { startOfBusinessDay } from "@/server/mcp/guards";
import { createRateLimiter } from "@/server/mcp/rate-limit";
import { addDaysLocal, parseWhen, whenOut } from "@/server/mcp/shared";
import { cleanText, containsUntrusted, personName, quoted, untrusted } from "@/server/mcp/text";
import { ReportInputError } from "@/server/reports/range";

const SECRET = randomBytes(32).toString("base64");
const NOW = new Date("2026-11-14T01:00:00Z");

describe("canonicalJson", () => {
  test("sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("confirm tokens", () => {
  const base = {
    secret: SECRET,
    tool: "cancel_booking",
    ownerId: "o1",
    args: { bookingId: "b", reason: "r" },
    now: NOW,
  };
  const mint = () => createConfirmToken({ ...base, ttlMs: CONFIRM_TTL_MS }).token;

  test("verify for the same tool, owner and arguments (key order does not matter)", () => {
    const token = mint();
    const verdict = verifyConfirmToken({ ...base, args: { reason: "r", bookingId: "b" }, token });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.tokenId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fail for another tool, owner, argument value, extra argument or secret", () => {
    const token = mint();
    for (const change of [
      { tool: "move_booking" },
      { ownerId: "o2" },
      { args: { bookingId: "b", reason: "R" } },
      { args: { bookingId: "b", reason: "r", extra: 1 } },
      { args: { bookingId: "b" } },
      { secret: randomBytes(32).toString("base64") },
    ]) {
      expect(verifyConfirmToken({ ...base, ...change, token })).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  test("expire exactly at the ttl", () => {
    const token = mint();
    expect(
      verifyConfirmToken({ ...base, token, now: new Date(NOW.getTime() + CONFIRM_TTL_MS) }).ok,
    ).toBe(true);
    expect(
      verifyConfirmToken({ ...base, token, now: new Date(NOW.getTime() + CONFIRM_TTL_MS + 1) }),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("tampering with the expiry or mac is detected; junk is malformed", () => {
    const [v, , nonce, mac] = mint().split(".");
    const later = `${v}.${NOW.getTime() + 10 * CONFIRM_TTL_MS}.${nonce}.${mac}`;
    expect(verifyConfirmToken({ ...base, token: later })).toEqual({ ok: false, reason: "invalid" });
    for (const junk of [
      "",
      "a.b.c",
      "v1.x.n.m",
      "v1.1.bad nonce.m",
      "v9.1.n.m",
      `v1.${NOW.getTime()}.${nonce}`,
    ]) {
      expect(verifyConfirmToken({ ...base, token: junk }).ok).toBe(false);
    }
    expect(
      verifyConfirmToken({ ...base, token: `v1.${NOW.getTime() + 1}.${nonce}.` }),
    ).toMatchObject({ ok: false });
  });

  test("every token is different, and a bad secret is a clear error", () => {
    expect(mint()).not.toBe(mint());
    expect(() => createConfirmToken({ ...base, secret: "c2hvcnQ=", ttlMs: 1 })).toThrow(/32 bytes/);
  });
});

describe("config", () => {
  test("safe defaults: money off, 200 per call, 500 per day", () => {
    expect(loadMcpConfig({})).toEqual({
      moneyToolsEnabled: false,
      maxMoneyCentsPerCall: 20000,
      maxMoneyCentsPerDay: 50000,
      requestsPerMinute: 60,
      writesPerMinute: 10,
    });
  });
  test("reads overrides and accepts the usual truthy spellings", () => {
    for (const on of ["true", "1", "YES", " on "]) {
      expect(loadMcpConfig({ MCP_MONEY_TOOLS_ENABLED: on }).moneyToolsEnabled).toBe(true);
    }
    for (const off of ["false", "0", "", "nope", undefined]) {
      expect(loadMcpConfig({ MCP_MONEY_TOOLS_ENABLED: off }).moneyToolsEnabled).toBe(false);
    }
    expect(
      loadMcpConfig({
        MCP_MAX_MONEY_CENTS: "5000",
        MCP_MAX_MONEY_DAILY_CENTS: "9000",
        MCP_RATE_LIMIT_PER_MIN: "5",
        MCP_WRITE_RATE_LIMIT_PER_MIN: "2",
      }),
    ).toMatchObject({
      maxMoneyCentsPerCall: 5000,
      maxMoneyCentsPerDay: 9000,
      requestsPerMinute: 5,
      writesPerMinute: 2,
    });
  });
  test("rejects nonsense with a readable error", () => {
    expect(() => loadMcpConfig({ MCP_MAX_MONEY_CENTS: "lots" })).toThrow(
      /Invalid MCP configuration/,
    );
    expect(() => loadMcpConfig({ MCP_MAX_MONEY_CENTS: "0" })).toThrow(/Invalid MCP configuration/);
    expect(() => loadMcpConfig({ MCP_MAX_MONEY_CENTS: "-5" })).toThrow(/Invalid MCP configuration/);
  });
});

describe("bearer authentication", () => {
  const token = "t".repeat(40);
  const req = (authorization?: string) =>
    new Request("https://x.test/api/mcp", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    });

  test("bearerTokenFrom parses the header", () => {
    expect(bearerTokenFrom(req("Bearer abc"))).toBe("abc");
    expect(bearerTokenFrom(req("bearer   abc  "))).toBe("abc");
    expect(bearerTokenFrom(req("Basic abc"))).toBeNull();
    expect(bearerTokenFrom(req("Bearer a b"))).toBeNull();
    expect(bearerTokenFrom(req())).toBeNull();
  });

  test("accepts only tokens whose SHA-256 is configured and reports a non-secret id", async () => {
    const auth = createBearerAuthenticator({ tokenHashes: [hashToken(token)], ownerId: "ryan" });
    expect(await auth.authenticate(req(`Bearer ${token}`))).toEqual({
      actor: "mcp",
      ownerId: "ryan",
      tokenId: hashToken(token).slice(0, 12),
    });
    expect(await auth.authenticate(req(`Bearer ${token}x`))).toBeNull();
    expect(await auth.authenticate(req(`Bearer ${token.slice(1)}`))).toBeNull();
    expect(await auth.authenticate(req("Bearer "))).toBeNull();
    expect(await auth.authenticate(req())).toBeNull();
  });

  test("supports two tokens at once for rotation", async () => {
    const other = "o".repeat(40);
    const auth = createBearerAuthenticator({
      tokenHashes: [hashToken(token), hashToken(other)],
      ownerId: "ryan",
    });
    expect(await auth.authenticate(req(`Bearer ${token}`))).not.toBeNull();
    expect(await auth.authenticate(req(`Bearer ${other}`))).not.toBeNull();
  });

  test("from env: hash preferred, raw accepted, nothing configured means null (fail closed)", async () => {
    expect(bearerAuthenticatorFromEnv({})).toBeNull();
    const byHash = bearerAuthenticatorFromEnv({
      MCP_API_TOKEN_HASH: ` ${hashToken(token).toUpperCase()} ,${hashToken("z".repeat(40))}`,
      MCP_OWNER_ID: "ryan",
    });
    expect(await byHash!.authenticate(req(`Bearer ${token}`))).toMatchObject({ ownerId: "ryan" });
    const byRaw = bearerAuthenticatorFromEnv({ MCP_API_TOKEN: token });
    expect(await byRaw!.authenticate(req(`Bearer ${token}`))).toMatchObject({ ownerId: "owner" });
    expect(() => bearerAuthenticatorFromEnv({ MCP_API_TOKEN_HASH: "not-a-hash" })).toThrow(
      /SHA-256/,
    );
    expect(() => bearerAuthenticatorFromEnv({ MCP_API_TOKEN: "short" })).toThrow(/at least 32/);
  });
});

describe("rate limiter", () => {
  test("allows the limit, blocks after it, and reopens when the window passes", () => {
    let now = new Date("2026-11-14T01:00:00Z");
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    expect(limiter.check("a")).toEqual({ allowed: true, remaining: 1, retryAfterSec: 0 });
    expect(limiter.check("a").remaining).toBe(0);
    now = new Date(now.getTime() + 20_000);
    expect(limiter.check("a")).toEqual({ allowed: false, remaining: 0, retryAfterSec: 40 });
    expect(limiter.check("b").allowed).toBe(true);
    now = new Date(now.getTime() + 40_000);
    expect(limiter.check("a").allowed).toBe(true);
  });

  test("works with the real clock and prunes old windows", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1 });
    for (let i = 0; i < 6000; i += 1) limiter.check(`k${i}`);
    expect(limiter.check("fresh").allowed).toBe(true);
  });
});

describe("untrusted text", () => {
  test("strips controls, zero-width and bidi characters but keeps newlines and accents", () => {
    const raw =
      "Zoë\u200B \u202Eevil\u0000\u0007\u009F\u2066x\u2069\uFEFF\r\nline2\r\n\r\n\r\n\r\nline3";
    expect(cleanText(raw).text).toBe("Zoë evilx\nline2\n\nline3");
  });
  test("normalises to NFC and caps by characters, not bytes", () => {
    expect(cleanText("é").text).toBe("é");
    expect(cleanText("😀".repeat(10), 4)).toEqual({ text: "😀😀😀😀", truncated: true });
    expect(cleanText("abc", 3).truncated).toBe(false);
  });
  test("untrusted wraps strings, keeps null, flags truncation", () => {
    expect(untrusted(null)).toBeNull();
    expect(untrusted(undefined)).toBeNull();
    expect(untrusted("hi")).toEqual({ untrusted: true, text: "hi" });
    expect(untrusted("abcdef", 3)).toEqual({ untrusted: true, text: "abc", truncated: true });
  });
  test("quoted gives one-line JSON literals", () => {
    expect(quoted(null)).toBe('""');
    expect(quoted('He said "hi"\nthen left')).toBe('"He said \\"hi\\" then left"');
    expect(quoted("x".repeat(100)).length).toBe(82);
  });
  test("containsUntrusted finds wrappers anywhere", () => {
    expect(containsUntrusted({ a: [{ b: { untrusted: true, text: "x" } }] })).toBe(true);
    expect(containsUntrusted({ a: [1, "x", null], b: { untrusted: false } })).toBe(false);
    expect(containsUntrusted("plain")).toBe(false);
  });
  test("personName handles missing parts", () => {
    expect(personName("Sam", "")).toBe("Sam");
    expect(personName("", "")).toBe("(no name)");
    expect(personName("Sam", "Lee")).toBe("Sam Lee");
  });
});

describe("error mapping", () => {
  const silence = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  test("tool errors keep their code and details", () => {
    expect(toErrorBody(new McpToolError("not_found", "nope", { id: 1 }))).toEqual({
      error: { code: "not_found", message: "nope", details: { id: 1 } },
    });
  });
  test("zod and report errors become invalid_input", () => {
    const zerr = z.object({ n: z.number() }).safeParse({ n: "x" }).error!;
    const body = toErrorBody(zerr);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.details?.issues).toEqual([{ path: "n", message: expect.any(String) }]);
    expect(toErrorBody(new ReportInputError("bad range")).error).toMatchObject({
      code: "invalid_input",
      message: "bad range",
    });
  });
  test("unfinished domain code is backend_unavailable", () => {
    expect(toErrorBody(new Error("createHold not implemented")).error.code).toBe(
      "backend_unavailable",
    );
  });
  test("unexpected errors are logged but never echoed", () => {
    const spy = silence();
    const body = toErrorBody(new Error('relation "secret_table" does not exist'), "list_bookings");
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("secret_table"));
    spy.mockRestore();
    const spy2 = silence();
    expect(toErrorBody("a string").error.code).toBe("internal_error");
    spy2.mockRestore();
  });
  test("callBackend passes McpToolErrors and stubs through and wraps the rest", async () => {
    await expect(callBackend(async () => 5)).resolves.toBe(5);
    await expect(
      callBackend(async () => {
        throw new McpToolError("not_found", "x");
      }),
    ).rejects.toBeInstanceOf(McpToolError);
    await expect(
      callBackend(async () => {
        throw new Error("fn not implemented");
      }),
    ).rejects.toThrow(/not implemented/);
    await expect(
      callBackend(async () => {
        throw new Error("line one\nline two");
      }),
    ).rejects.toMatchObject({ code: "backend_error", message: "line one" });
    await expect(
      callBackend(async () => {
        throw "weird";
      }),
    ).rejects.toBe("weird");
  });
});

describe("time helpers", () => {
  const TZ = "Australia/Melbourne";
  test("parseWhen reads offsets exactly and bare times in the business zone", () => {
    expect(parseWhen("2026-11-20T15:00:00+11:00", TZ).toISOString()).toBe(
      "2026-11-20T04:00:00.000Z",
    );
    expect(parseWhen("2026-11-20T15:00", TZ).toISOString()).toBe("2026-11-20T04:00:00.000Z");
    expect(parseWhen("2026-07-20T15:00", TZ).toISOString()).toBe("2026-07-20T05:00:00.000Z"); // AEST, UTC+10
    expect(parseWhen("2026-11-20T04:00:00Z", TZ).toISOString()).toBe("2026-11-20T04:00:00.000Z");
    expect(() => parseWhen("soon-ish", TZ, "start")).toThrow(/start is not a valid/);
  });
  test("whenOut and addDaysLocal", () => {
    expect(whenOut(new Date("2026-11-20T04:00:00Z"), TZ)).toEqual({
      utc: "2026-11-20T04:00:00.000Z",
      local: "Fri 20 Nov 2026, 3:00 pm",
    });
    expect(addDaysLocal("2026-11-30", 1, TZ)).toBe("2026-12-01");
  });
  test("startOfBusinessDay is local midnight", () => {
    expect(startOfBusinessDay(NOW, TZ).toISOString()).toBe("2026-11-13T13:00:00.000Z");
    expect(startOfBusinessDay(new Date("2026-11-13T12:59:00Z"), TZ).toISOString()).toBe(
      "2026-11-12T13:00:00.000Z",
    );
  });
});
