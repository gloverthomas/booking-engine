import { Resend } from "resend";
import { PermanentSendError, type EmailMessage, type EmailSender, type SendResult } from "../types";
import { isPermanentStatus } from "./http";

/** The slice of the Resend SDK we use, so tests can pass a fake. */
export interface ResendLike {
  emails: {
    send(payload: {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
      replyTo?: string;
      attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
    }): Promise<{
      data: { id: string } | null;
      error: { message: string; statusCode: number | null } | null;
    }>;
  };
}

export interface ResendOptions {
  apiKey: string;
  /** e.g. `Ryan Kennedy <bookings@example.com>` */
  from: string;
  client?: ResendLike;
}

export function createResendSender({ apiKey, from, client }: ResendOptions): EmailSender {
  const resend: ResendLike = client ?? (new Resend(apiKey) as unknown as ResendLike);
  return {
    async send(message: EmailMessage): Promise<SendResult> {
      const { data, error } = await resend.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
      });
      if (error) {
        const status = error.statusCode ?? 0;
        const text = `Resend error${status ? ` ${status}` : ""}: ${error.message}`;
        if (isPermanentStatus(status)) throw new PermanentSendError(text);
        throw new Error(text);
      }
      return { providerMessageId: data?.id ?? null };
    },
  };
}
