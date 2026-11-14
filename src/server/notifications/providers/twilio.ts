import { z } from "zod";
import type { SendResult, SmsMessage, SmsProvider } from "../types";
import { basicAuth, failFromStatus, type FetchLike } from "./http";

const responseSchema = z.object({ sid: z.string() });

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Alphanumeric sender ID or an owned number. */
  from: string;
  fetch?: FetchLike;
}

export function createTwilioProvider(options: TwilioOptions): SmsProvider {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  return {
    async send({ to, body }: SmsMessage): Promise<SendResult> {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: basicAuth(options.accountSid, options.authToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: options.from, Body: body }).toString(),
      });
      const text = await response.text();
      if (!response.ok) failFromStatus("Twilio", response.status, text);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Twilio returned a non-JSON response");
      }
      return { providerMessageId: responseSchema.parse(json).sid };
    },
  };
}
