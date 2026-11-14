import { z } from "zod";
import { PermanentSendError, type SendResult, type SmsMessage, type SmsProvider } from "../types";
import { basicAuth, failFromStatus, type FetchLike } from "./http";

const ENDPOINT = "https://rest.clicksend.com/v3/sms/send";

const responseSchema = z.object({
  response_code: z.string().optional(),
  response_msg: z.string().optional(),
  data: z
    .object({
      messages: z
        .array(z.object({ status: z.string().optional(), message_id: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

export interface ClickSendOptions {
  username: string;
  apiKey: string;
  /** Alphanumeric sender ID (must be registered in Australia) or an owned number. */
  senderId?: string;
  fetch?: FetchLike;
}

export function createClickSendProvider(options: ClickSendOptions): SmsProvider {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async send({ to, body }: SmsMessage): Promise<SendResult> {
      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: basicAuth(options.username, options.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            {
              to,
              body,
              source: "booking-engine",
              ...(options.senderId ? { from: options.senderId } : {}),
            },
          ],
        }),
      });
      const text = await response.text();
      if (!response.ok) failFromStatus("ClickSend", response.status, text);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("ClickSend returned a non-JSON response");
      }
      const parsed = responseSchema.parse(json);
      const message = parsed.data?.messages?.[0];
      if (parsed.response_code !== "SUCCESS" || (message?.status && message.status !== "SUCCESS")) {
        throw new PermanentSendError(
          `ClickSend rejected the message: ${message?.status ?? parsed.response_code ?? "unknown"}`,
        );
      }
      return { providerMessageId: message?.message_id ?? null };
    },
  };
}
