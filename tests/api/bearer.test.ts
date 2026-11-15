import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { session } from "@/db/auth-schema";
import { staff } from "@/db/schema";
import { createAuth, type Auth } from "@/server/auth/auth";
import { parseOwnerEmails } from "@/server/auth/owners";
import { resolveAccess } from "@/server/auth/resolve-access";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

/** The signed `set-auth-token` form needs a real Google sign-in; it is checked against staging instead. */
const SECRET = "test-secret-test-secret-test-secret-123";
let harness: Harness;
let auth: Auth;
let owners: ReadonlySet<string>;
let staffEmails: Set<string>;

beforeEach(async () => {
  harness = await createTestDb();
  await seedBasics(harness.db);
  owners = parseOwnerEmails("ryan@example.com");
  staffEmails = new Set(["mia@example.com"]);
  auth = createAuth({
    db: harness.db,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    google: { clientId: ["web-client", "ios-client"], clientSecret: "secret" },
    ownerEmails: () => owners,
    isStaffEmail: async (email) => staffEmails.has(email),
    secureCookies: false,
  });
});
afterEach(async () => {
  await harness.client.close();
});

/** A real Better Auth session for an allowed user, as the token the app would hold. */
async function bearerFor(email: string): Promise<{ raw: string; userId: string }> {
  const ctx = await auth.$context;
  const { user } = await ctx.internalAdapter.createOAuthUser(
    { email, name: email, emailVerified: true },
    { accountId: `g-${email}`, providerId: "google" },
  );
  const created = await ctx.internalAdapter.createSession(user.id);
  return { raw: created.token, userId: user.id };
}

const withBearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

describe("bearer sessions for the mobile app", () => {
  test("accepts both Google client ids, so the iOS app's tokens verify", () => {
    expect(auth.options.socialProviders?.google?.clientId).toEqual(["web-client", "ios-client"]);
  });

  test("a bearer token resolves to the same user a cookie session would", async () => {
    const { raw, userId } = await bearerFor("ryan@example.com");
    const result = await auth.api.getSession({ headers: withBearer(raw) });
    expect(result?.user.id).toBe(userId);
    expect(result?.user.email).toBe("ryan@example.com");
  });

  test.each(["", "not-a-token", "abc.def", "Bearer"])(
    "a bad token (%j) is no session",
    async (token) => {
      await bearerFor("ryan@example.com");
      expect(await auth.api.getSession({ headers: withBearer(token) })).toBeNull();
    },
  );

  test("a guessed or altered token is no session", async () => {
    const { raw } = await bearerFor("ryan@example.com");
    const altered = `${raw.slice(0, -2)}${raw.endsWith("a") ? "bb" : "aa"}`;
    expect(await auth.api.getSession({ headers: withBearer(altered) })).toBeNull();
  });

  test("no Authorization header and no cookie is no session", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
  });

  test("signing out revokes the token immediately", async () => {
    const { raw } = await bearerFor("ryan@example.com");
    await auth.api.signOut({ headers: withBearer(raw) });
    expect(await auth.api.getSession({ headers: withBearer(raw) })).toBeNull();
    expect(await harness.db.select().from(session)).toHaveLength(0);
  });

  test("a stylist's token gives a stylist; deactivating them cuts access at the next call", async () => {
    await harness.db
      .insert(staff)
      .values({ name: "Mia", email: "mia@example.com", role: "stylist" });
    const { raw } = await bearerFor("mia@example.com");
    const found = await auth.api.getSession({ headers: withBearer(raw) });
    const user = { id: found!.user.id, email: found!.user.email, name: found!.user.name };

    const access = await resolveAccess(harness.db, user, owners);
    expect(access).toMatchObject({ role: "stylist", email: "mia@example.com" });

    await harness.db.update(staff).set({ active: false }).where(eq(staff.email, "mia@example.com"));
    expect(await resolveAccess(harness.db, user, owners)).toBeNull();
  });

  test("someone outside the allow-list cannot get a session at all", async () => {
    await expect(bearerFor("stranger@example.com")).rejects.toBeDefined();
  });
});
