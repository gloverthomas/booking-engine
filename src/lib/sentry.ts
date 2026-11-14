/**
 * Sentry configuration shared by the web app (server + browser) and the worker.
 *
 * Privacy first: this app holds clients' names, emails, phone numbers and booking links. Nothing like
 * that may leave for a third party, so every event is scrubbed before sending and default PII
 * collection is off. Sentry stays completely disabled until a DSN is configured.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** +61 410 766 029, 0410 766 029, (03) 9123 4567, 61410766029 ... any 8+ digit run with phone punctuation. */
const PHONE = /(?<![\w.])(?:\+?\d[\d\s().-]{7,}\d)(?![\w.])/g;
/** Manage-booking tokens and public booking ids in URLs. */
const TOKEN_PATHS = /(\/(?:manage|bookings|confirmed)\/)[^/?#\s"']+/gi;
const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key|session|signature/i;
const BODY_KEYS = new Set(["data", "body", "query_string", "cookies"]);

const MAX_DEPTH = 8;

export function redactString(value: string): string {
  return value
    .replace(TOKEN_PATHS, "$1[token]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]");
}

/** Deep, non-mutating redaction of any JSON-like value. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(inner, depth + 1),
    ]),
  );
}

/**
 * Scrub a Sentry event: strip the signed-in user and request bodies/cookies/headers, then redact
 * emails, phone numbers and manage-booking tokens from everything that remains.
 */
export function scrubEvent<T extends object>(event: T): T {
  const copy: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  delete copy.user;

  const request = copy.request;
  if (request && typeof request === "object") {
    const kept = Object.fromEntries(
      Object.entries(request as Record<string, unknown>).filter(
        ([key]) => !BODY_KEYS.has(key) && key !== "headers",
      ),
    );
    copy.request = kept;
  }
  return redactValue(copy) as T;
}

export interface SentryEnv {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: string | number;
}

/** Options for Sentry.init. Returns `{ enabled: false }` when no DSN is set so nothing is sent. */
export function sentryOptions(env: SentryEnv) {
  if (!env.dsn) return { enabled: false as const };
  const rate = Number(env.tracesSampleRate ?? 0.1);
  return {
    enabled: true as const,
    dsn: env.dsn,
    environment: env.environment ?? "production",
    release: env.release,
    sendDefaultPii: false,
    tracesSampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0.1,
    beforeSend: <E extends object>(event: E): E => scrubEvent(event),
    beforeSendTransaction: <E extends object>(event: E): E => scrubEvent(event),
    beforeBreadcrumb: <B extends object>(breadcrumb: B): B => redactValue(breadcrumb) as B,
  };
}
