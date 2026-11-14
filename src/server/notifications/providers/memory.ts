import type { LogFn } from "@/lib/logger";
import type { EmailMessage, EmailSender, SendResult, SmsMessage, SmsProvider } from "../types";

export interface MemoryEmailSender extends EmailSender {
  readonly sent: EmailMessage[];
}
export interface MemorySmsProvider extends SmsProvider {
  readonly sent: SmsMessage[];
}

/** Records instead of sending. Used by tests. */
export function createMemoryEmailSender(): MemoryEmailSender {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message): Promise<SendResult> {
      sent.push(message);
      return { providerMessageId: `mem-email-${sent.length}` };
    },
  };
}

export function createMemorySmsProvider(): MemorySmsProvider {
  const sent: SmsMessage[] = [];
  return {
    sent,
    async send(message): Promise<SendResult> {
      sent.push(message);
      return { providerMessageId: `mem-sms-${sent.length}` };
    },
  };
}

/** Dev provider: writes the message to the structured log instead of sending it. */
export function createConsoleSmsProvider(log: LogFn): SmsProvider {
  return {
    async send({ to, body }): Promise<SendResult> {
      log({ event: "sms_console", to, body });
      return { providerMessageId: null };
    },
  };
}

/** Dev email sender used when RESEND_API_KEY is absent in development. */
export function createConsoleEmailSender(log: LogFn): EmailSender {
  return {
    async send({ to, subject, text, attachments }): Promise<SendResult> {
      log({
        event: "email_console",
        to,
        subject,
        text,
        attachments: attachments?.map((a) => a.filename) ?? [],
      });
      return { providerMessageId: null };
    },
  };
}
