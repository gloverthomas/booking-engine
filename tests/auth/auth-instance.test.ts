import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { createAuth, type Auth } from "@/server/auth/auth";
import { parseOwnerEmails } from "@/server/auth/owners";
import { user, session } from "@/db/auth-schema";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

describe("Better Auth instance with the owner allow-list", () => {
  let harness: Harness;
  let auth: Auth;
  let owners: ReadonlySet<string>;

  beforeEach(async () => {
    harness = await createTestDb();
    owners = parseOwnerEmails("ryan@example.com");
    auth = createAuth({
      db: harness.db,
      secret: "test-secret-test-secret-test-secret-123",
      baseURL: "http://localhost:3000",
      google: { clientId: "id", clientSecret: "secret" },
      ownerEmails: () => owners,
      secureCookies: false,
    });
  });

  afterEach(async () => {
    await harness.client.close();
  });

  /** The same adapter call the real Google callback makes when a new identity arrives. */
  async function signUpViaGoogle(email: string) {
    const ctx = await auth.$context;
    return ctx.internalAdapter.createOAuthUser(
      { email, name: email, emailVerified: true },
      { accountId: `g-${email}`, providerId: "google" },
    );
  }

  test("is configured for Google only, with no password sign-in", () => {
    expect(Object.keys(auth.options.socialProviders ?? {})).toEqual(["google"]);
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    expect(auth.options.trustedOrigins).toEqual(["http://localhost:3000"]);
  });

  test("hardens the session cookie", () => {
    expect(auth.options.advanced?.defaultCookieAttributes).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(auth.options.advanced?.cookiePrefix).toBe("rk-admin");
  });

  test("validateUserInfo rejects a non-owner Google identity before any account is created", async () => {
    const validate = auth.options.user?.validateUserInfo;
    expect(validate).toBeTypeOf("function");
    const source = { action: "create-user", method: "oauth" } as const;
    const stranger = await validate?.({
      user: { email: "stranger@example.com", emailVerified: true },
      source,
    });
    expect(stranger).toMatchObject({ error: "not_authorised" });
    const owner = await validate?.({
      user: { email: "Ryan@example.com", emailVerified: true },
      source,
    });
    expect(owner).toBeUndefined();
  });

  test("an owner can get an account and a session", async () => {
    const ctx = await auth.$context;
    const { user: created } = await signUpViaGoogle("ryan@example.com");
    expect(created.email).toBe("ryan@example.com");
    const sess = await ctx.internalAdapter.createSession(created.id);
    expect(sess.userId).toBe(created.id);
    expect(await harness.db.select().from(session)).toHaveLength(1);
  });

  test("a non-owner never gets a user row, even if something upstream let them through", async () => {
    await expect(signUpViaGoogle("stranger@example.com")).rejects.toBeDefined();
    expect(await harness.db.select().from(user)).toHaveLength(0);
  });

  test("an owner who is later removed from the allow-list cannot start a new session", async () => {
    const ctx = await auth.$context;
    const { user: created } = await signUpViaGoogle("ryan@example.com");
    owners = parseOwnerEmails("someone-else@example.com");
    await expect(ctx.internalAdapter.createSession(created.id)).resolves.toBeNull();
    expect(await harness.db.select().from(session).where(eq(session.userId, created.id))).toEqual(
      [],
    );
  });
});
