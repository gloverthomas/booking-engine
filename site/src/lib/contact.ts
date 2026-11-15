import { z } from "zod";

export const TOPICS = {
  general: "General question",
  support: "Support",
  privacy: "Privacy request",
  other: "Other",
} as const;

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200),
  topic: z.enum(["general", "support", "privacy", "other"]),
  message: z.string().trim().min(10).max(4000),
  /** Honeypot: real people never fill this in. */
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(4096).optional(),
});

export interface OutgoingMessage {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
}

export interface ContactDeps {
  send(message: OutgoingMessage): Promise<void>;
  /** Present only when a Turnstile secret is configured. */
  verifyTurnstile?(token: string, ip: string): Promise<boolean>;
  allow(ip: string): boolean;
  config: { to?: string; from?: string };
  log(entry: Record<string, unknown>): void;
}

export interface ContactResult {
  status: number;
  body: { success: boolean; error?: string };
}

const CONTROL = /[\u0000-\u001f\u007f]+/g;
const oneLine = (value: string) => value.replace(CONTROL, " ").trim();

/**
 * Validate and forward a contact message by email. Message content is never logged or stored here:
 * it goes to the inbox and nowhere else.
 */
export async function handleContact(
  input: unknown,
  ip: string,
  deps: ContactDeps,
): Promise<ContactResult> {
  if (!deps.allow(ip)) {
    return {
      status: 429,
      body: { success: false, error: "Too many messages. Please try again later." },
    };
  }

  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 400,
      body: { success: false, error: "Please check your details and write a short message." },
    };
  }
  const data = parsed.data;

  // Bots fill every field. Pretend it worked so they learn nothing.
  if (data.website) return { status: 200, body: { success: true } };

  if (deps.verifyTurnstile) {
    const ok = data.turnstileToken ? await deps.verifyTurnstile(data.turnstileToken, ip) : false;
    if (!ok) {
      return {
        status: 400,
        body: { success: false, error: "We couldn't confirm you're human. Please try again." },
      };
    }
  }

  const { to, from } = deps.config;
  if (!to || !from) {
    deps.log({ event: "contact_not_configured" });
    return {
      status: 503,
      body: {
        success: false,
        error: "The contact form isn't available yet. Please email hello@hairmate.world instead.",
      },
    };
  }

  const name = oneLine(data.name);
  try {
    await deps.send({
      to,
      from,
      replyTo: data.email,
      subject: `[HairMate] ${TOPICS[data.topic]} from ${name}`,
      text: `${data.message}\n\n--\nFrom: ${name} <${data.email}>\nTopic: ${TOPICS[data.topic]}`,
    });
  } catch (error) {
    deps.log({
      event: "contact_send_failed",
      message: error instanceof Error ? error.message : "unknown",
    });
    return {
      status: 502,
      body: {
        success: false,
        error: "We couldn't send your message. Please email hello@hairmate.world.",
      },
    };
  }
  return { status: 200, body: { success: true } };
}
