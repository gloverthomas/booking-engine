import { describe, expect, test, vi } from "vitest";
import type { AccessSession } from "@/server/auth/access-core";
import { createAccessGuard, type GuardDeps } from "@/server/auth/guard";

class RedirectSignal extends Error {
  constructor(readonly reason?: string) {
    super("login");
  }
}

const ryan: AccessSession = {
  userId: "u1",
  email: "ryan@example.com",
  staffId: "s1",
  role: "owner",
};

function makeGuard(overrides: Partial<GuardDeps> = {}) {
  const redirectToLogin = vi.fn((reason?: string): never => {
    throw new RedirectSignal(reason);
  });
  const resolveAccess = vi.fn(async () => ryan as AccessSession | null);
  const deps: GuardDeps = {
    getSession: async () => ({ user: { id: "u1", email: "ryan@example.com" } }),
    resolveAccess,
    redirectToLogin,
    onError: () => undefined,
    ...overrides,
  };
  return { guard: createAccessGuard(deps), redirectToLogin, resolveAccess };
}

describe("access guard", () => {
  test("requireSession returns the resolved session for an allowed-in user", async () => {
    const { guard, redirectToLogin, resolveAccess } = makeGuard();
    await expect(guard.requireSession()).resolves.toEqual(ryan);
    expect(resolveAccess).toHaveBeenCalledWith({ id: "u1", email: "ryan@example.com" });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  test("requireSession redirects to plain /login when signed out, without resolving anyone", async () => {
    const { guard, redirectToLogin, resolveAccess } = makeGuard({ getSession: async () => null });
    await expect(guard.requireSession()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectToLogin).toHaveBeenCalledWith(undefined);
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  test("a signed-in user who is no longer allowed in goes to /login with a reason (no redirect loop)", async () => {
    const { guard, redirectToLogin } = makeGuard({ resolveAccess: async () => null });
    await expect(guard.getSession()).resolves.toBeNull();
    await expect(guard.requireSession()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectToLogin).toHaveBeenCalledWith("not_authorised");
  });

  test("access is re-resolved on every call, so removing someone revokes it on their next request", async () => {
    let allowed = true;
    const { guard } = makeGuard({ resolveAccess: async () => (allowed ? ryan : null) });
    expect(await guard.getSession()).not.toBeNull();
    allowed = false;
    expect(await guard.getSession()).toBeNull();
  });

  test("getSession returns null instead of throwing when the lookup fails, and reports it", async () => {
    const onError = vi.fn();
    const failure = new Error("db down");
    const { guard } = makeGuard({
      getSession: async () => {
        throw failure;
      },
      onError,
    });
    await expect(guard.getSession()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test("requireSession does not mask an infrastructure failure as a logged-out user", async () => {
    const { guard, redirectToLogin } = makeGuard({
      resolveAccess: async () => {
        throw new Error("db down");
      },
    });
    await expect(guard.requireSession()).rejects.toThrow("db down");
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});
