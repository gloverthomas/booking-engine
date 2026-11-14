import { describe, expect, test, vi } from "vitest";
import { createOwnerGuard, type GuardDeps } from "@/server/auth/guard";
import { parseOwnerEmails } from "@/server/auth/owners";

class RedirectSignal extends Error {}

function makeGuard(overrides: Partial<GuardDeps> = {}) {
  const redirectToLogin = vi.fn((): never => {
    throw new RedirectSignal("login");
  });
  const deps: GuardDeps = {
    getSession: async () => ({ user: { id: "u1", email: "ryan@example.com" } }),
    ownerEmails: () => parseOwnerEmails("ryan@example.com"),
    redirectToLogin,
    onError: () => undefined,
    ...overrides,
  };
  return { guard: createOwnerGuard(deps), redirectToLogin };
}

describe("owner guard", () => {
  test("requireOwner returns the owner session for an allow-listed user", async () => {
    const { guard, redirectToLogin } = makeGuard();
    await expect(guard.requireOwner()).resolves.toEqual({
      userId: "u1",
      email: "ryan@example.com",
    });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  test("requireOwner redirects to login when there is no session", async () => {
    const { guard, redirectToLogin } = makeGuard({ getSession: async () => null });
    await expect(guard.requireOwner()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  test("a signed-in user who is not (or no longer) on the allow-list is treated as signed out", async () => {
    const { guard, redirectToLogin } = makeGuard({
      getSession: async () => ({ user: { id: "u2", email: "intruder@example.com" } }),
    });
    await expect(guard.getOwnerSession()).resolves.toBeNull();
    await expect(guard.requireOwner()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  test("removing an owner from OWNER_EMAILS revokes access on the next call", async () => {
    let owners = parseOwnerEmails("ryan@example.com");
    const { guard } = makeGuard({ ownerEmails: () => owners });
    expect(await guard.getOwnerSession()).not.toBeNull();
    owners = parseOwnerEmails("someone-else@example.com");
    expect(await guard.getOwnerSession()).toBeNull();
  });

  test("an empty allow-list locks everyone out", async () => {
    const { guard } = makeGuard({ ownerEmails: () => parseOwnerEmails(undefined) });
    expect(await guard.getOwnerSession()).toBeNull();
  });

  test("getOwnerSession returns null instead of throwing when the session lookup fails, and reports it", async () => {
    const onError = vi.fn();
    const failure = new Error("db down");
    const { guard } = makeGuard({
      getSession: async () => {
        throw failure;
      },
      onError,
    });
    await expect(guard.getOwnerSession()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test("requireOwner does not mask an infrastructure failure as a logged-out user", async () => {
    const { guard, redirectToLogin } = makeGuard({
      getSession: async () => {
        throw new Error("db down");
      },
    });
    await expect(guard.requireOwner()).rejects.toThrow("db down");
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});
