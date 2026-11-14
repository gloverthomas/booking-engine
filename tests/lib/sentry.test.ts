import { describe, expect, test } from "vitest";
import { redactString, redactValue, scrubEvent, sentryOptions } from "@/lib/sentry";

describe("redactString", () => {
  test("removes emails, AU phone numbers and manage-booking tokens", () => {
    const out = redactString(
      "Failed for sam@example.com on +61 410 766 029 / 0410766029 at /manage/abc-123.xyz?x=1",
    );
    expect(out).not.toMatch(/sam@example|410 766|0410766029|abc-123/);
    expect(out).toContain("[email]");
    expect(out).toContain("[phone]");
    expect(out).toContain("/manage/[token]");
  });

  test("leaves ordinary text, ids and short numbers alone", () => {
    const text = "booking 7b1c1c3e-6d0f-4d1e-9f27-0e3a5a1f9c11 total 9500 cents";
    expect(redactString(text)).toBe(text);
  });
});

describe("redactValue", () => {
  test("redacts nested strings, blanks sensitive keys, and does not mutate the input", () => {
    const input = {
      msg: "hi sam@example.com",
      nested: [{ phone: "0410 766 029", apiKey: "sk_live_123", Authorization: "Bearer x" }],
    };
    const out = redactValue(input) as typeof input;
    expect(out.msg).toBe("hi [email]");
    expect(out.nested[0]).toEqual({
      phone: "[phone]",
      apiKey: "[redacted]",
      Authorization: "[redacted]",
    });
    expect(input.msg).toBe("hi sam@example.com");
  });

  test("passes primitives through and truncates very deep structures", () => {
    expect(redactValue(5)).toBe(5);
    expect(redactValue(null)).toBeNull();
    let deep: Record<string, unknown> = { v: "x" };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[truncated]");
  });
});

describe("scrubEvent", () => {
  test("drops the user and request body, cookies and headers, and redacts what remains", () => {
    const event = {
      message: "boom for sam@example.com",
      user: { id: "1", email: "sam@example.com", ip_address: "1.2.3.4" },
      request: {
        url: "https://x.test/manage/tok.en",
        method: "POST",
        data: { phone: "0410766029" },
        cookies: { a: "b" },
        headers: { cookie: "a=b" },
        query_string: "email=sam@example.com",
      },
      exception: { values: [{ value: "Cannot send to sam@example.com" }] },
    };
    const out = scrubEvent(event) as Record<string, unknown>;
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({ url: "https://x.test/manage/[token]", method: "POST" });
    expect(JSON.stringify(out)).not.toMatch(/sam@example|0410766029|tok\.en/);
    expect(event.user.email).toBe("sam@example.com");
  });
});

describe("sentryOptions", () => {
  test("is disabled without a DSN, so nothing is ever sent", () => {
    expect(sentryOptions({})).toEqual({ enabled: false });
    expect(sentryOptions({ dsn: "" })).toEqual({ enabled: false });
  });

  test("enabled options turn off default PII, clamp the sample rate and scrub events", () => {
    const o = sentryOptions({ dsn: "https://k@o0.ingest.sentry.io/1", tracesSampleRate: "5" });
    if (!o.enabled) throw new Error("expected enabled");
    expect(o.sendDefaultPii).toBe(false);
    expect(o.tracesSampleRate).toBe(1);
    expect(o.environment).toBe("production");
    expect(JSON.stringify(o.beforeSend({ message: "a@b.co" }))).not.toContain("a@b.co");
    expect(JSON.stringify(o.beforeBreadcrumb({ message: "a@b.co" }))).not.toContain("a@b.co");
    expect(JSON.stringify(o.beforeSendTransaction({ transaction: "/manage/tok" }))).toContain(
      "[token]",
    );
    expect(sentryOptions({ dsn: "x", tracesSampleRate: "nope" })).toMatchObject({
      tracesSampleRate: 0.1,
    });
    expect(sentryOptions({ dsn: "x", environment: "staging" })).toMatchObject({
      environment: "staging",
    });
  });
});
