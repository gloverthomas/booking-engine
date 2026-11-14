import type { LogFn } from "@/lib/logger";

export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
  contentType?: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
}

export interface SmsMessage {
  /** E.164, e.g. +61410123456. */
  to: string;
  body: string;
}

export interface SendResult {
  providerMessageId: string | null;
}

/** Port: anything that can deliver an email. Adapters live in ./providers. */
export interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>;
}

/** Port: anything that can deliver an SMS. Adapters live in ./providers. */
export interface SmsProvider {
  send(message: SmsMessage): Promise<SendResult>;
}

/**
 * A failure that retrying cannot fix (bad address, rejected content, 4xx from the provider).
 * Anything else thrown by a sender is treated as transient and the job is retried.
 */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSendError";
  }
}

export interface NotificationConfig {
  /** Public base URL used to build manage links. */
  appUrl: string;
  /** Base64 key for manage tokens. */
  encryptionKey: string;
  /** Who receives owner alerts. Empty disables them. */
  ownerEmails: string[];
}

/**
 * Everything the notification code needs from the outside world. All members are lazy so that a
 * missing key only fails the moment something is actually sent, never at import time.
 */
export interface NotificationDeps {
  email: () => EmailSender;
  sms: () => SmsProvider;
  config: () => NotificationConfig;
  now: () => Date;
  log: LogFn;
}
