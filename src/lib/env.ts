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
