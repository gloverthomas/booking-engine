import { z } from "zod";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const responseSchema = z.object({
  success: z.boolean(),
  "error-codes": z.array(z.string()).optional(),
});

export type TurnstileResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; reason: "missing_token" | "rejected" | "unreachable" | "not_configured" };

export interface VerifyTurnstileOptions {
  token: string | undefined;
  remoteIp?: string;
  /** TURNSTILE_SECRET_KEY. When absent, development skips the check and production fails closed. */
  secret: string | undefined;
  nodeEnv: "development" | "test" | "production";
  fetchImpl?: typeof fetch;
  /** Abort the siteverify call after this long so a Cloudflare outage cannot hang bookings. */
  timeoutMs?: number;
}

/**
 * Server-side Cloudflare Turnstile verification. Tokens are single-use, so the caller must
 * verify exactly once per submission and have the widget issue a fresh token after a failure.
 */
export async function verifyTurnstile(options: VerifyTurnstileOptions): Promise<TurnstileResult> {
  const { token, remoteIp, secret, nodeEnv, fetchImpl = fetch, timeoutMs = 5_000 } = options;

  if (!secret) {
    return nodeEnv === "production"
      ? { ok: false, reason: "not_configured" }
      : { ok: true, skipped: true };
  }
  if (!token) return { ok: false, reason: "missing_token" };

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== "unknown") form.set("remoteip", remoteIp);

  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, reason: "unreachable" };
    return parsed.data.success ? { ok: true } : { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
