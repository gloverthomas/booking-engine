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
const resolveAccess = vi.fn();
vi.mock("@/server/auth/resolve-access", () => ({
  resolveAccess: (db: unknown, user: unknown, owners: ReadonlySet<string>) =>
    resolveAccess(db, user, owners),
  isActiveStaffEmail: async () => false,
}));
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
    resolveAccess.mockReset();
    resolveAccess.mockImplementation(async (_db, user: { id: string; email: string }) => ({
      userId: user.id,
      email: user.email,
      staffId: "s1",
      role: "owner",
    }));
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

  test("a signed-in person who is not allowed in is sent to /login with a reason", async () => {
    getSession.mockResolvedValue({ user: { id: "u2", email: "stranger@example.com" } });
    resolveAccess.mockResolvedValue(null);
    const { requireOwner, requireAccessSession, getAccessSession } = await import("@/server/auth");
    await expect(requireOwner()).rejects.toThrow("NEXT_REDIRECT:/login?error=not_authorised");
    await expect(requireAccessSession()).rejects.toThrow(
      "NEXT_REDIRECT:/login?error=not_authorised",
    );
    await expect(getAccessSession()).resolves.toBeNull();
  });

  test("passes the OWNER_EMAILS allow-list to the resolver", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "ryan@example.com" } });
    const { requireAccessSession } = await import("@/server/auth");
    await requireAccessSession();
    expect([...resolveAccess.mock.calls[0][2]]).toEqual(["ryan@example.com"]);
  });

  test("requireOwner means role owner: a manager is denied (not redirected), but is an access session", async () => {
    getSession.mockResolvedValue({ user: { id: "u3", email: "mia@example.com" } });
    resolveAccess.mockResolvedValue({
      userId: "u3",
      email: "mia@example.com",
      staffId: "s3",
      role: "manager",
    });
    const { requireOwner, getOwnerSession, requireAccessSession } = await import("@/server/auth");
    const { AccessDeniedError } = await import("@/server/auth/access-core");
    await expect(requireOwner()).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getOwnerSession()).resolves.toBeNull();
    await expect(requireAccessSession()).resolves.toMatchObject({ role: "manager" });
    expect(redirectMock).not.toHaveBeenCalled();
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
