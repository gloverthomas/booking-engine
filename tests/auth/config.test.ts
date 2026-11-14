import { describe, expect, test } from "vitest";
import { parseEnv } from "@/lib/env";
import { readAuthConfig } from "@/server/auth/config";
import type { Db } from "@/server/db-types";

const db = {} as Db;
const good = {
  DATABASE_URL: "postgres://u:p@localhost:5432/x",
  BETTER_AUTH_SECRET: "s".repeat(40),
  APP_URL: "https://admin.example.com/some/path",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csecret",
  OWNER_EMAILS: "Ryan@Example.com, other@example.com",
};

describe("readAuthConfig", () => {
  test("builds config from a complete environment, using only the origin of APP_URL", () => {
    const config = readAuthConfig(parseEnv({ ...good, NODE_ENV: "production" }), db);
    expect(config.baseURL).toBe("https://admin.example.com");
    expect(config.secureCookies).toBe(true);
    expect(config.google).toEqual({ clientId: "cid", clientSecret: "csecret" });
    expect([...config.ownerEmails()].sort()).toEqual(["other@example.com", "ryan@example.com"]);
  });

  test("allows insecure cookies only for plain-http local development", () => {
    const config = readAuthConfig(
      parseEnv({ ...good, APP_URL: "http://localhost:3000", NODE_ENV: "development" }),
      db,
    );
    expect(config.secureCookies).toBe(false);
  });

  test("names every missing key in one error", () => {
    const env = parseEnv({ DATABASE_URL: good.DATABASE_URL });
    expect(() => readAuthConfig(env, db)).toThrow(
      /BETTER_AUTH_SECRET.*APP_URL.*GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*OWNER_EMAILS/,
    );
  });

  test("rejects a short secret and an allow-list with no addresses", () => {
    expect(() => readAuthConfig(parseEnv({ ...good, BETTER_AUTH_SECRET: "short" }), db)).toThrow(
      /at least 32/,
    );
    expect(() => readAuthConfig(parseEnv({ ...good, OWNER_EMAILS: " , " }), db)).toThrow(
      /OWNER_EMAILS/,
    );
  });
});
