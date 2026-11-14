import { describe, expect, test, vi } from "vitest";
import { handleContact, type ContactDeps } from "@/lib/contact";
import { createLimiter } from "@/lib/rate-limit";

const valid = {
  name: "Sam Client",
  email: "sam@example.com",
  topic: "privacy",
  message: "Please delete my details.",
};

function deps(
  over: Partial<ContactDeps> = {},
): ContactDeps & { sent: Array<Parameters<ContactDeps["send"]>[0]> } {
  const sent: Array<Parameters<ContactDeps["send"]>[0]> = [];
  return {
    sent,
    send: async (m) => {
      sent.push(m);
    },
    allow: () => true,
    config: { to: "inbox@example.com", from: "HairMate <hello@hairmate.shop>" },
    log: vi.fn(),
    ...over,
  };
}

describe("handleContact", () => {
  test("forwards a valid message with the visitor as reply-to and a clear subject", async () => {
    const d = deps();
    const result = await handleContact(valid, "1.1.1.1", d);
    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toMatchObject({
      to: "inbox@example.com",
      replyTo: "sam@example.com",
      subject: "[HairMate] Privacy request from Sam Client",
    });
    expect(d.sent[0].text).toContain("Please delete my details.");
  });

  test("rejects bad input with a generic message and sends nothing", async () => {
    const d = deps();
    for (const bad of [
      null,
      {},
      { ...valid, email: "nope" },
      { ...valid, message: "short" },
      { ...valid, topic: "spam" },
      { ...valid, name: "" },
    ]) {
      const result = await handleContact(bad, "1.1.1.1", d);
      expect(result.status).toBe(400);
    }
    expect(d.sent).toHaveLength(0);
  });

  test("a filled honeypot looks like success but sends nothing", async () => {
    const d = deps();
    const result = await handleContact({ ...valid, website: "http://spam.example" }, "1.1.1.1", d);
    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(d.sent).toHaveLength(0);
  });

  test("rate limits per IP", async () => {
    const d = deps({ allow: createLimiter(2, 1000, () => 0) });
    expect((await handleContact(valid, "9.9.9.9", d)).status).toBe(200);
    expect((await handleContact(valid, "9.9.9.9", d)).status).toBe(200);
    expect((await handleContact(valid, "9.9.9.9", d)).status).toBe(429);
    expect((await handleContact(valid, "8.8.8.8", d)).status).toBe(200);
  });

  test("when Turnstile is configured a missing or failed token is refused", async () => {
    const verify = vi.fn(async (token: string) => token === "good");
    const d = deps({ verifyTurnstile: verify });
    expect((await handleContact(valid, "1.1.1.1", d)).status).toBe(400);
    expect((await handleContact({ ...valid, turnstileToken: "bad" }, "1.1.1.1", d)).status).toBe(
      400,
    );
    expect((await handleContact({ ...valid, turnstileToken: "good" }, "1.1.1.1", d)).status).toBe(
      200,
    );
    expect(verify).toHaveBeenCalledTimes(2);
  });

  test("not configured: friendly 503 pointing at the email address", async () => {
    const d = deps({ config: {} });
    const result = await handleContact(valid, "1.1.1.1", d);
    expect(result.status).toBe(503);
    expect(result.body.error).toContain("hello@hairmate.shop");
  });

  test("a provider failure is a 502 and the message content is never logged", async () => {
    const log = vi.fn();
    const d = deps({
      log,
      send: async () => {
        throw new Error("resend down");
      },
    });
    const result = await handleContact(valid, "1.1.1.1", d);
    expect(result.status).toBe(502);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Please delete");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sam@example.com");
  });

  test("control characters in the name cannot break the subject line", async () => {
    const d = deps();
    await handleContact({ ...valid, name: "Sam\r\nBcc: evil@example.com" }, "1.1.1.1", d);
    expect(d.sent[0].subject).not.toMatch(/[\r\n]/);
  });
});
