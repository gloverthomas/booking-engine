import { z } from "zod";

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// URL"),
  /** Public base URL, used in links we send (e.g. https://book.example.com). */
  APP_URL: z.string().url().optional(),
  /** 32 bytes, base64. Encrypts integration tokens at rest. `openssl rand -base64 32` */
  ENCRYPTION_KEY: z.string().optional(),
  /** Comma-separated emails allowed to sign in to the admin. */
  OWNER_EMAILS: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** OAuth client id of the iOS app. Its Google ID tokens are accepted by /api/v1/auth/google. */
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMS_PROVIDER: z.enum(["clicksend", "twilio", "console"]).optional(),
  SMS_SENDER_ID: z.string().optional(),
  CLICKSEND_USERNAME: z.string().optional(),
  CLICKSEND_API_KEY: z.string().optional(),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  /** Comma-separated origins allowed to embed /book in an iframe. */
  PUBLIC_EMBED_ORIGINS: z.string().optional(),
  PUBLIC_TRUSTED_PROXY_HOPS: z.string().optional(),
  /** MCP server (see src/server/mcp). Prefer the hash; generate with `openssl rand -hex 32`. */
  MCP_API_TOKEN_HASH: z.string().optional(),
  MCP_API_TOKEN: z.string().optional(),
  MCP_OWNER_ID: z.string().optional(),
  MCP_MONEY_TOOLS_ENABLED: z.string().optional(),
  MCP_MAX_MONEY_CENTS: z.string().optional(),
  MCP_MAX_MONEY_DAILY_CENTS: z.string().optional(),
  MCP_RATE_LIMIT_PER_MIN: z.string().optional(),
  MCP_WRITE_RATE_LIMIT_PER_MIN: z.string().optional(),
  /** Error monitoring. Off until a DSN is set. */
  SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  BUSINESS_TIMEZONE: z
    .string()
    .default("Australia/Melbourne")
    .refine(isValidTimeZone, "BUSINESS_TIMEZONE must be a valid IANA time zone"),
});

export type Env = z.infer<typeof envSchema>;

/** Validate an environment-like object. Throws one readable error listing every problem. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Validated process environment, parsed once. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
