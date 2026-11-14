import { describe, expect, test, vi } from "vitest";
import type { Env } from "@/lib/env";
import { parseEnv } from "@/lib/env";
import { createClickSendProvider } from "@/server/notifications/providers/clicksend";
import {
  configFromEnv,
  createDefaultDeps,
  createEmailSenderFromEnv,
  createSmsProviderFromEnv,
} from "@/server/notifications/providers";
import {
  createConsoleEmailSender,
  createConsoleSmsProvider,
  createMemoryEmailSender,
  createMemorySmsProvider,
} from "@/server/notifications/providers/memory";
import { createResendSender, type ResendLike } from "@/server/notifications/providers/resend";
import { createTwilioProvider } from "@/server/notifications/providers/twilio";
import { PermanentSendError } from "@/server/notifications/types";

const DB = "postgres://x:x@localhost:5432/x";

function env(extra: Record<string, string>): Env {
  return parseEnv({ DATABASE_URL: DB, ...extra });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("Resend adapter", () => {
  const message = {
    to: ["sam@example.com"],
    subject: "Hi",
    html: "<p>Hi</p>",
    text: "Hi",
    attachments: [
      { filename: "a.ics", content: new Uint8Array([65, 66]), contentType: "text/calendar" },
    ],
  };

  test("maps the message, attaches files as buffers and returns the provider id", async () => {
    const send = vi.fn<ResendLike["emails"]["send"]>(async () => ({
      data: { id: "re_1" },
      error: null,
    }));
    const sender = createResendSender({
      apiKey: "k",
      from: "Ryan <bookings@example.com>",
      client: { emails: { send } },
    });
    await expect(sender.send(message)).resolves.toEqual({ providerMessageId: "re_1" });
    const payload = send.mock.calls[0][0];
    expect(payload.from).toBe("Ryan <bookings@example.com>");
    expect(payload.attachments?.[0].content.toString()).toBe("AB");
  });

  test("a 4xx error is permanent", async () => {
    const sender = createResendSender({
      apiKey: "k",
      from: "f",
      client: {
        emails: {
          send: async () => ({ data: null, error: { message: "bad address", statusCode: 422 } }),
        },
      },
    });
    await expect(sender.send(message)).rejects.toBeInstanceOf(PermanentSendError);
  });

  test("a 429, 5xx or unknown status is transient", async () => {
    for (const statusCode of [429, 500, null]) {
      const sender = createResendSender({
        apiKey: "k",
        from: "f",
        client: {
          emails: { send: async () => ({ data: null, error: { message: "x", statusCode } }) },
        },
      });
      const error = await sender.send(message).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PermanentSendError);
    }
  });

  test("builds a real client when none is injected", () => {
    expect(() => createResendSender({ apiKey: "re_test", from: "f" })).not.toThrow();
  });
});

describe("ClickSend adapter", () => {
  const ok = {
    response_code: "SUCCESS",
    data: { messages: [{ status: "SUCCESS", message_id: "cs-1" }] },
  };

  test("posts to the v3 endpoint with basic auth and the sender id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, ok));
    const provider = createClickSendProvider({
      username: "ryan",
      apiKey: "secret",
      senderId: "RyanKennedy",
      fetch: fetchMock,
    });
    await expect(provider.send({ to: "+61410123456", body: "Hello" })).resolves.toEqual({
      providerMessageId: "cs-1",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rest.clicksend.com/v3/sms/send");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("ryan:secret").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string).messages[0]).toMatchObject({
      to: "+61410123456",
      body: "Hello",
      from: "RyanKennedy",
    });
  });

  test("omits `from` when no sender id is configured", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, ok));
    await createClickSendProvider({ username: "u", apiKey: "k", fetch: fetchMock }).send({
      to: "+61410123456",
      body: "x",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).messages[0]).not.toHaveProperty("from");
  });

  test("a rejected message status is permanent", async () => {
    const provider = createClickSendProvider({
      username: "u",
      apiKey: "k",
      fetch: async () =>
        jsonResponse(200, {
          response_code: "SUCCESS",
          data: { messages: [{ status: "INVALID_RECIPIENT" }] },
        }),
    });
    await expect(provider.send({ to: "+61410123456", body: "x" })).rejects.toBeInstanceOf(
      PermanentSendError,
    );
  });

  test("HTTP 401 is permanent, 503 is transient, junk body is transient", async () => {
    const make = (status: number, body: string) =>
      createClickSendProvider({
        username: "u",
        apiKey: "k",
        fetch: async () => jsonResponse(status, body),
      });
    await expect(make(401, "nope").send({ to: "+61410123456", body: "x" })).rejects.toBeInstanceOf(
      PermanentSendError,
    );
    const transient = await make(503, "down")
      .send({ to: "+61410123456", body: "x" })
      .catch((e: unknown) => e);
    expect(transient).not.toBeInstanceOf(PermanentSendError);
    await expect(make(200, "<html>").send({ to: "+61410123456", body: "x" })).rejects.toThrow(
      /non-JSON/,
    );
  });
});

describe("Twilio adapter", () => {
  test("posts a form body with basic auth and returns the sid", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { sid: "SM123" }));
    const provider = createTwilioProvider({
      accountSid: "AC1",
      authToken: "tok",
      from: "RyanK",
      fetch: fetchMock,
    });
    await expect(provider.send({ to: "+61410123456", body: "Hi there" })).resolves.toEqual({
      providerMessageId: "SM123",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("To")).toBe("+61410123456");
    expect(form.get("From")).toBe("RyanK");
    expect(form.get("Body")).toBe("Hi there");
  });

  test("error handling mirrors the other adapters", async () => {
    const make = (status: number, body: string) =>
      createTwilioProvider({
        accountSid: "AC1",
        authToken: "t",
        from: "f",
        fetch: async () => jsonResponse(status, body),
      });
    await expect(make(400, "bad").send({ to: "+61410123456", body: "x" })).rejects.toBeInstanceOf(
      PermanentSendError,
    );
    await expect(
      make(500, "boom").send({ to: "+61410123456", body: "x" }),
    ).rejects.not.toBeInstanceOf(PermanentSendError);
    await expect(make(201, "oops").send({ to: "+61410123456", body: "x" })).rejects.toThrow(
      /non-JSON/,
    );
  });
});

describe("memory and console providers", () => {
  test("memory providers record what they are given", async () => {
    const email = createMemoryEmailSender();
    const sms = createMemorySmsProvider();
    await email.send({ to: ["a@b.c"], subject: "s", html: "h", text: "t" });
    await sms.send({ to: "+61410123456", body: "b" });
    expect(email.sent).toHaveLength(1);
    expect(sms.sent[0].body).toBe("b");
  });

  test("console providers log instead of sending", async () => {
    const log = vi.fn();
    await createConsoleSmsProvider(log).send({ to: "+61410123456", body: "b" });
    await createConsoleEmailSender(log).send({
      to: ["a@b.c"],
      subject: "s",
      html: "h",
      text: "t",
      attachments: [{ filename: "x.ics", content: new Uint8Array() }],
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "sms_console" }));
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_console", attachments: ["x.ics"] }),
    );
  });
});

describe("factories read env lazily and fail clearly", () => {
  const log = vi.fn();

  test("creating default deps never touches env", () => {
    expect(() => createDefaultDeps()).not.toThrow();
  });

  test("email: missing key and missing from are reported by name", () => {
    expect(() => createEmailSenderFromEnv(env({ NODE_ENV: "production" }), log)).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() =>
      createEmailSenderFromEnv(env({ NODE_ENV: "production", RESEND_API_KEY: "re_1" }), log),
    ).toThrow(/EMAIL_FROM/);
  });

  test("email: configured production uses Resend, development without a key logs", async () => {
    expect(
      createEmailSenderFromEnv(
        env({ NODE_ENV: "production", RESEND_API_KEY: "re_1", EMAIL_FROM: "a@b.c" }),
        log,
      ),
    ).toBeDefined();
    const dev = createEmailSenderFromEnv(env({ NODE_ENV: "development" }), log);
    await dev.send({ to: ["a@b.c"], subject: "s", html: "h", text: "t" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "email_dev_fallback" }));
  });

  test("sms: unset provider is a clear error", () => {
    expect(() => createSmsProviderFromEnv(env({}), log, {})).toThrow(/SMS_PROVIDER is not set/);
  });

  test("sms: console, clicksend and twilio selection", () => {
    expect(createSmsProviderFromEnv(env({ SMS_PROVIDER: "console" }), log, {})).toBeDefined();
    expect(() => createSmsProviderFromEnv(env({ SMS_PROVIDER: "clicksend" }), log, {})).toThrow(
      /CLICKSEND_USERNAME/,
    );
    expect(
      createSmsProviderFromEnv(
        env({ SMS_PROVIDER: "clicksend", CLICKSEND_USERNAME: "u", CLICKSEND_API_KEY: "k" }),
        log,
        {},
      ),
    ).toBeDefined();
    expect(() => createSmsProviderFromEnv(env({ SMS_PROVIDER: "twilio" }), log, {})).toThrow(
      /TWILIO_ACCOUNT_SID/,
    );
    expect(() =>
      createSmsProviderFromEnv(env({ SMS_PROVIDER: "twilio" }), log, {
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
      }),
    ).toThrow(/SMS_SENDER_ID/);
    expect(
      createSmsProviderFromEnv(env({ SMS_PROVIDER: "twilio", SMS_SENDER_ID: "RyanK" }), log, {
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
      }),
    ).toBeDefined();
  });

  test("config: needs APP_URL and ENCRYPTION_KEY, trims slashes, parses owner emails", () => {
    expect(() => configFromEnv(env({}))).toThrow(/APP_URL/);
    expect(() => configFromEnv(env({ APP_URL: "https://x.com" }))).toThrow(/ENCRYPTION_KEY/);
    expect(
      configFromEnv(
        env({
          APP_URL: "https://x.com//",
          ENCRYPTION_KEY: "k",
          OWNER_EMAILS: " a@x.com, b@x.com ,",
        }),
      ),
    ).toEqual({ appUrl: "https://x.com", encryptionKey: "k", ownerEmails: ["a@x.com", "b@x.com"] });
  });
});
