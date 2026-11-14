import { z } from "zod";

/** Env var names, in one place so docs and tests agree. */
export const MCP_ENV = {
  token: "MCP_API_TOKEN",
  tokenHash: "MCP_API_TOKEN_HASH",
  ownerId: "MCP_OWNER_ID",
  moneyEnabled: "MCP_MONEY_TOOLS_ENABLED",
  maxMoneyCents: "MCP_MAX_MONEY_CENTS",
  maxMoneyDailyCents: "MCP_MAX_MONEY_DAILY_CENTS",
  rateLimit: "MCP_RATE_LIMIT_PER_MIN",
  writeRateLimit: "MCP_WRITE_RATE_LIMIT_PER_MIN",
} as const;

/** How long a preview's confirm token stays valid. */
export const CONFIRM_TTL_MS = 5 * 60 * 1000;

const flag = z
  .string()
  .optional()
  .transform((v) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase()));

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const configSchema = z.object({
  /** Kill switch for refund_payment and charge_no_show_fee. Off unless explicitly enabled. */
  moneyToolsEnabled: flag,
  /** Largest single refund or fee, in cents. */
  maxMoneyCentsPerCall: positiveInt(20_000),
  /** Most money all MCP money tools may move in one business-local day, in cents. */
  maxMoneyCentsPerDay: positiveInt(50_000),
  /** All requests per token per minute. */
  requestsPerMinute: positiveInt(60),
  /** Write and money tool calls per token per minute. */
  writesPerMinute: positiveInt(10),
});

export type McpConfig = z.infer<typeof configSchema>;

/** Parse MCP settings from the environment. Throws one readable error when a value is malformed. */
export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const result = configSchema.safeParse({
    moneyToolsEnabled: env[MCP_ENV.moneyEnabled],
    maxMoneyCentsPerCall: env[MCP_ENV.maxMoneyCents],
    maxMoneyCentsPerDay: env[MCP_ENV.maxMoneyDailyCents],
    requestsPerMinute: env[MCP_ENV.rateLimit],
    writesPerMinute: env[MCP_ENV.writeRateLimit],
  });
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid MCP configuration: ${problems}`);
  }
  return result.data;
}
