import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getSession = vi.fn();
const redirectMock = vi.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "x=1" }) }));
const rethrow = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
  unstable_rethrow: (error: unknown) => rethrow(error),
}));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth/auth", () => ({
  createAuth: () => ({ api: { getSession } }),
}));

const ENV_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "APP_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OWNER_EMAILS",
] as const;

describe("requireOwner / getOwnerSession wiring", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    getSession.mockReset();
    rethrow.mockReset();
    redirectMock.mockClear();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/x";
    process.env.BETTER_AUTH_SECRET = "s".repeat(40);
    process.env.APP_URL = "http://localhost:3000";
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    process.env.OWNER_EMAILS = "ryan@example.com";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("returns the owner session when Better Auth finds one for an allow-listed email", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "ryan@example.com" } });
    const { requireOwner, getOwnerSession } = await import("@/server/auth");
    await expect(requireOwner()).resolves.toEqual({ userId: "u1", email: "ryan@example.com" });
    await expect(getOwnerSession()).resolves.toEqual({ userId: "u1", email: "ryan@example.com" });
    expect(getSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
  });

  test("redirects to /login when signed out", async () => {
    getSession.mockResolvedValue(null);
    const { requireOwner, getOwnerSession } = await import("@/server/auth");
    await expect(requireOwner()).rejects.toThrow("NEXT_REDIRECT:/login");
    await expect(getOwnerSession()).resolves.toBeNull();
  });

  test("treats a signed-in non-owner as signed out", async () => {
    getSession.mockResolvedValue({ user: { id: "u2", email: "stranger@example.com" } });
    const { requireOwner } = await import("@/server/auth");
    await expect(requireOwner()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  test("getOwnerSession logs and returns null when the lookup fails", async () => {
    getSession.mockRejectedValue(new Error("boom"));
    const { getOwnerSession } = await import("@/server/auth");
    await expect(getOwnerSession()).resolves.toBeNull();
    expect(rethrow).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
  });

  test("lets Next's control-flow errors (e.g. a prerender bailout) propagate instead of reporting signed out", async () => {
    const bailout = new Error("NEXT_PRERENDER_INTERRUPTED");
    rethrow.mockImplementationOnce((error: unknown) => {
      throw error;
    });
    getSession.mockRejectedValue(bailout);
    const { getOwnerSession } = await import("@/server/auth");
    await expect(getOwnerSession()).rejects.toBe(bailout);
  });

  test("fails with a clear message, only when used, if sign-in is not configured", async () => {
    delete process.env.BETTER_AUTH_SECRET;
    const { requireOwner } = await import("@/server/auth");
    await expect(requireOwner()).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });
});
