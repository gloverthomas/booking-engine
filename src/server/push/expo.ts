/** Expo's push service: one HTTPS call delivers to Apple's notification service for us. */

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export type PushTicket =
  { status: "ok" } | { status: "error"; message: string; error: string | null };

export interface PushSender {
  /** One ticket per message, in order. Throws when the service itself could not be reached. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
}

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;

export const EXPO_TOKEN_PATTERN = /^(Expo|Exponent)PushToken\[[^\]\s]+\]$/;

export function isExpoToken(token: string): boolean {
  return EXPO_TOKEN_PATTERN.test(token);
}

export interface ExpoSenderOptions {
  accessToken?: string;
  fetch?: typeof fetch;
}

export function createExpoSender(options: ExpoSenderOptions = {}): PushSender {
  const doFetch = options.fetch ?? fetch;

  async function sendBatch(batch: readonly PushMessage[]): Promise<PushTicket[]> {
    const response = await doFetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      },
      body: JSON.stringify(
        batch.map((m) => ({ ...m, sound: "default", priority: "high", channelId: "default" })),
      ),
    });
    if (!response.ok) throw new Error(`Expo push service replied ${response.status}`);

    const json = (await response.json()) as { data?: unknown };
    const tickets = Array.isArray(json.data) ? json.data : [];
    if (tickets.length !== batch.length) {
      throw new Error("Expo push service returned an unexpected number of tickets");
    }
    return tickets.map((t): PushTicket => {
      const ticket = t as { status?: string; message?: string; details?: { error?: string } };
      return ticket.status === "ok"
        ? { status: "ok" }
        : {
            status: "error",
            message: ticket.message ?? "Unknown error",
            error: ticket.details?.error ?? null,
          };
    });
  }

  return {
    async send(messages) {
      const out: PushTicket[] = [];
      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        out.push(...(await sendBatch(messages.slice(i, i + BATCH_SIZE))));
      }
      return out;
    },
  };
}
