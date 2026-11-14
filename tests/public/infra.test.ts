import { describe, expect, it, vi } from "vitest";
import { RateLimiter, createPublicLimiters } from "@/lib/public-api-rate-limit";
import { ApiError, clientIp, guard, ok, parseOrThrow, readJson } from "@/lib/public-api-http";
import { classifyDomainError, toApiError } from "@/lib/public-api-errors";
import { buildIcs, escapeIcsText, googleCalendarUrl } from "@/lib/public-api-ics";
import { frameAncestorsValue, parseEmbedOrigins, publicFrameHeaders } from "@/lib/public-api-frame";
import { verifyTurnstile } from "@/lib/turnstile";
import { z } from "zod";

describe("RateLimiter", () => {
  it("allows up to the limit then blocks until the window resets", () => {
    let t = 1_000;
    const limiter = new RateLimiter(2, 60_000, () => t);
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = limiter.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
    expect(limiter.check("b").allowed).toBe(true);
    t += 60_001;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("prunes expired buckets when the map grows", () => {
    let t = 0;
    const limiter = new RateLimiter(1, 10, () => t);
    for (let i = 0; i < 5_001; i++) limiter.check(`k${i}`);
    t = 100;
    expect(limiter.check("fresh").allowed).toBe(true);
  });

  it("creates the standard limiters", () => {
    const limiters = createPublicLimiters(() => 0);
    expect(Object.keys(limiters).sort()).toEqual(["availability", "hold", "mutate", "read"]);
  });
});

describe("http helpers", () => {
  it("wraps success and failure in the envelope with no-store", async () => {
    const res = ok({ a: 1 }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ success: true, data: { a: 1 } });
  });

  it("guard converts ApiError and hides unexpected errors", async () => {
    const log = vi.fn();
    const known = await guard(
      () => Promise.reject(new ApiError(409, "slot_taken", "Taken", undefined, { "X-A": "1" })),
      log,
      "t",
    );
    expect(known.status).toBe(409);
    expect(known.headers.get("x-a")).toBe("1");
    expect((await known.json()).error.code).toBe("slot_taken");

    const unknown = await guard(() => Promise.reject(new Error("db password leaked")), log, "t");
    expect(unknown.status).toBe(500);
    const body = await unknown.json();
    expect(JSON.stringify(body)).not.toContain("password");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "public_api_unexpected" }));

    await guard(() => Promise.reject("string failure"), log, "t");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("reads bounded JSON", async () => {
    const good = new Request("http://x/", { method: "POST", body: '{"a":1}' });
    expect(await readJson(good)).toEqual({ a: 1 });
    await expect(
      readJson(new Request("http://x/", { method: "POST", body: "{" })),
    ).rejects.toMatchObject({ code: "invalid_json" });
    await expect(
      readJson(new Request("http://x/", { method: "POST", body: "x".repeat(40_000) })),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    await expect(
      readJson(
        new Request("http://x/", {
          method: "POST",
          body: "{}",
          headers: { "content-length": "99999" },
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("parseOrThrow produces a 422 with field errors", () => {
    const schema = z.object({ email: z.email("Bad email") });
    expect(() => parseOrThrow(schema, { email: "x" })).toThrowError(ApiError);
    try {
      parseOrThrow(schema, { email: "x" });
    } catch (e) {
      expect(e).toMatchObject({ status: 422, fieldErrors: { email: "Bad email" } });
    }
    expect(parseOrThrow(schema, { email: "a@b.co" })).toEqual({ email: "a@b.co" });
  });

  it("reads the client ip from the trusted end of x-forwarded-for", () => {
    const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.1" }), 2)).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }), 5)).toBe("9.9.9.9");
    expect(clientIp(req({ "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("domain error mapping", () => {
  it("classifies by code, SQLSTATE, cause and message", () => {
    expect(classifyDomainError({ code: "slot_taken" })).toBe("slot_taken");
    expect(classifyDomainError({ code: "23P01" })).toBe("slot_taken");
    expect(classifyDomainError(new Error("Slot is no longer available"))).toBe("slot_taken");
    expect(classifyDomainError(new Error("wrapped", { cause: { code: "23P01" } }))).toBe(
      "slot_taken",
    );
    expect(classifyDomainError(new Error("policy version mismatch"))).toBe("policy_changed");
    expect(classifyDomainError(new Error("Booking not found"))).toBe("not_found");
    expect(classifyDomainError(new Error("already cancelled"))).toBe("invalid_state");
    expect(classifyDomainError(new Error("client is blocked"))).toBe("client_blocked");
    expect(classifyDomainError(new Error("within 24 hours"))).toBe("too_late");
    expect(classifyDomainError(new Error("kaboom"))).toBe("unknown");
    expect(classifyDomainError("nope")).toBe("unknown");
  });

  it("maps to friendly API errors and leaves unknown ones to the caller", () => {
    expect(toApiError({ code: "slot_taken" }, "hold")).toMatchObject({
      status: 409,
      code: "slot_taken",
    });
    expect(toApiError({ code: "policy_changed" }, "hold")?.code).toBe("policy_changed");
    expect(toApiError({ code: "too_late" }, "reschedule")?.message).toContain("move online");
    expect(toApiError({ code: "too_late" }, "cancel")?.message).toContain("change online");
    expect(toApiError({ code: "not_found" }, "cancel")?.status).toBe(404);
    expect(toApiError({ code: "invalid_state" }, "cancel")?.code).toBe("invalid_state");
    expect(toApiError({ code: "client_blocked" }, "hold")?.status).toBe(403);
    expect(toApiError(new Error("kaboom"), "hold")).toBeNull();
  });
});

describe("ics", () => {
  const event = {
    uid: "abc@bookings",
    title: "Haircut, Beard Trim with Ryan; Co",
    description: "Line one\nLine two",
    location: "Northside, 302 Rathdowne Street",
    start: new Date("2026-11-20T03:30:00Z"),
    end: new Date("2026-11-20T04:15:00Z"),
    now: new Date("2026-11-14T00:00:00Z"),
  };

  it("builds a valid single-event calendar with CRLF line endings", () => {
    const ics = buildIcs(event);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261120T033000Z");
    expect(ics).toContain("DTEND:20261120T041500Z");
    expect(ics).toContain("DTSTAMP:20261114T000000Z");
    expect(ics).toContain("SUMMARY:Haircut\\, Beard Trim with Ryan\\; Co");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
    expect(ics).toContain("UID:abc@bookings");
  });

  it("folds long lines at 75 octets", () => {
    const ics = buildIcs({ ...event, description: "x".repeat(300) });
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("omits optional fields and escapes backslashes", () => {
    const ics = buildIcs({ ...event, description: undefined, location: undefined });
    expect(ics).not.toContain("LOCATION:");
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
  });

  it("builds a Google Calendar link", () => {
    const url = new URL(googleCalendarUrl(event));
    expect(url.hostname).toBe("calendar.google.com");
    expect(url.searchParams.get("dates")).toBe("20261120T033000Z/20261120T041500Z");
    expect(url.searchParams.get("location")).toContain("Northside");
    const bare = new URL(
      googleCalendarUrl({ ...event, description: undefined, location: undefined }),
    );
    expect(bare.searchParams.has("details")).toBe(false);
  });
});

describe("frame headers", () => {
  it("parses and sanitises origins", () => {
    expect(
      parseEmbedOrigins(
        "https://a.com, https://a.com/, http://localhost:3000, javascript:alert(1), https://b.com/path",
      ),
    ).toEqual(["https://a.com", "http://localhost:3000"]);
    expect(parseEmbedOrigins(undefined)).toEqual([]);
  });

  it("only allows self when nothing is configured", () => {
    expect(frameAncestorsValue(undefined)).toBe("frame-ancestors 'self'");
    expect(frameAncestorsValue("https://a.com")).toBe("frame-ancestors 'self' https://a.com");
  });

  it("covers the booking and manage routes only", () => {
    const rules = publicFrameHeaders("https://a.com");
    expect(rules.map((r) => r.source)).toEqual(["/book", "/book/:path*", "/manage/:path*"]);
    expect(rules[0].headers[0].key).toBe("Content-Security-Policy");
  });
});

describe("verifyTurnstile", () => {
  const response = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("skips in development without a secret, fails closed in production", async () => {
    expect(
      await verifyTurnstile({ token: undefined, secret: undefined, nodeEnv: "development" }),
    ).toEqual({
      ok: true,
      skipped: true,
    });
    expect(await verifyTurnstile({ token: "t", secret: undefined, nodeEnv: "production" })).toEqual(
      {
        ok: false,
        reason: "not_configured",
      },
    );
  });

  it("requires a token when configured", async () => {
    expect(await verifyTurnstile({ token: "", secret: "s", nodeEnv: "production" })).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it("posts the secret, token and ip to Cloudflare", async () => {
    const fetchImpl = vi.fn(() => response({ success: true }));
    const result = await verifyTurnstile({
      token: "tok",
      remoteIp: "1.2.3.4",
      secret: "sec",
      nodeEnv: "production",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = init.body as URLSearchParams;
    expect(form.get("secret")).toBe("sec");
    expect(form.get("response")).toBe("tok");
    expect(form.get("remoteip")).toBe("1.2.3.4");
  });

  it("omits an unknown ip", async () => {
    const fetchImpl = vi.fn(() => response({ success: true }));
    await verifyTurnstile({
      token: "tok",
      remoteIp: "unknown",
      secret: "sec",
      nodeEnv: "production",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it("reports rejection and outages distinctly", async () => {
    const run = (fetchImpl: typeof fetch) =>
      verifyTurnstile({ token: "t", secret: "s", nodeEnv: "production", fetchImpl });
    expect(await run((() => response({ success: false })) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "rejected",
    });
    expect(await run((() => response({}, 500)) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(await run((() => response({ nope: 1 })) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(await run((() => Promise.reject(new Error("net"))) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
