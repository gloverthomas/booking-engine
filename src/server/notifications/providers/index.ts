import { getEnv, type Env } from "@/lib/env";
import { createLogger, type LogFn } from "@/lib/logger";
import type { EmailSender, NotificationConfig, NotificationDeps, SmsProvider } from "../types";
import { createClickSendProvider } from "./clicksend";
import { createConsoleEmailSender, createConsoleSmsProvider } from "./memory";
import { createResendSender } from "./resend";
import { createTwilioProvider } from "./twilio";

export { createClickSendProvider } from "./clicksend";
export {
  createConsoleEmailSender,
  createConsoleSmsProvider,
  createMemoryEmailSender,
  createMemorySmsProvider,
} from "./memory";
export { createResendSender } from "./resend";
export { createTwilioProvider } from "./twilio";

/** Raw env for keys the shared env schema does not know about (Twilio). */
type RawEnv = Record<string, string | undefined>;

function require(value: string | undefined, name: string, why: string): string {
  if (!value) throw new Error(`${name} is not set (${why})`);
  return value;
}

/** Chooses the email adapter. Throws a clear error only when called, i.e. when a send is attempted. */
export function createEmailSenderFromEnv(env: Env, log: LogFn): EmailSender {
  if (!env.RESEND_API_KEY && env.NODE_ENV === "development") {
    log({ event: "email_dev_fallback", note: "RESEND_API_KEY not set; logging emails instead" });
    return createConsoleEmailSender(log);
  }
  return createResendSender({
    apiKey: require(env.RESEND_API_KEY, "RESEND_API_KEY", "required to send email"),
    from: require(env.EMAIL_FROM, "EMAIL_FROM", 'required to send email, e.g. "Ryan <bookings@x.com>"'),
  });
}

/** Chooses the SMS adapter from SMS_PROVIDER. Throws a clear error only when called. */
export function createSmsProviderFromEnv(
  env: Env,
  log: LogFn,
  raw: RawEnv = process.env,
): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case "console":
      return createConsoleSmsProvider(log);
    case "clicksend":
      return createClickSendProvider({
        username: require(env.CLICKSEND_USERNAME, "CLICKSEND_USERNAME", "SMS_PROVIDER=clicksend"),
        apiKey: require(env.CLICKSEND_API_KEY, "CLICKSEND_API_KEY", "SMS_PROVIDER=clicksend"),
        senderId: env.SMS_SENDER_ID,
      });
    case "twilio":
      return createTwilioProvider({
        accountSid: require(raw.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID", "SMS_PROVIDER=twilio"),
        authToken: require(raw.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN", "SMS_PROVIDER=twilio"),
        from: require(env.SMS_SENDER_ID ?? raw.TWILIO_FROM, "SMS_SENDER_ID", "SMS_PROVIDER=twilio"),
      });
    default:
      throw new Error("SMS_PROVIDER is not set (use clicksend, twilio or console)");
  }
}

export function configFromEnv(env: Env): NotificationConfig {
  return {
    appUrl: require(env.APP_URL, "APP_URL", "needed to build manage-booking links").replace(
      /\/+$/,
      "",
    ),
    encryptionKey: require(env.ENCRYPTION_KEY, "ENCRYPTION_KEY", "needed to sign manage links"),
    ownerEmails: (env.OWNER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
  };
}

/** Production wiring. Every member reads env lazily on first use. */
export function createDefaultDeps(overrides: Partial<NotificationDeps> = {}): NotificationDeps {
  const log = overrides.log ?? createLogger("notifications");
  return {
    email: () => createEmailSenderFromEnv(getEnv(), log),
    sms: () => createSmsProviderFromEnv(getEnv(), log),
    config: () => configFromEnv(getEnv()),
    now: () => new Date(),
    log,
    ...overrides,
  };
}
