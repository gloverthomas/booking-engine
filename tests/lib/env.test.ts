import { describe, expect, test, vi } from "vitest";
import { parseEnv } from "@/lib/env";

const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("parseEnv", () => {
  test("returns typed config when required variables are present", () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  test("defaults NODE_ENV to development and timezone to Australia/Melbourne", () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    expect(env.BUSINESS_TIMEZONE).toBe("Australia/Melbourne");
  });

  test("throws a readable error naming the missing variable", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  test("rejects a DATABASE_URL that is not a postgres URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  test("rejects an unknown timezone", () => {
    expect(() => parseEnv({ ...valid, BUSINESS_TIMEZONE: "Mars/Olympus" })).toThrow(
      /BUSINESS_TIMEZONE/,
    );
  });
});

describe("getEnv", () => {
  test("reads process.env once and caches the result", async () => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db");
    const { getEnv } = await import("@/lib/env");
    const first = getEnv();
    vi.stubEnv("DATABASE_URL", "postgres://changed");
    expect(getEnv()).toBe(first);
    vi.unstubAllEnvs();
  });
});
