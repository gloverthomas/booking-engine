import { createHash, createHmac, randomBytes } from "node:crypto";
import { verifyBearerToken } from "better-auth/oauth2";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAuth, MCP_SCOPE, type Auth } from "@/server/auth/auth";
import { createOAuthAuthenticator } from "@/server/mcp/oauth";
import { parseOwnerEmails } from "@/server/auth/owners";
import { createTestDb } from "../helpers/test-db";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

const BASE = "http://localhost:3000";
const RESOURCE = "https://mcp.example.test/mcp";
const REDIRECT = "http://localhost:9999/callback";
const CLIENT_ID = "test-claude";
const SECRET = "test-secret-test-secret-test-secret-123";

const b64url = (buf: Buffer) => buf.toString("base64url");

/** The whole OAuth dance against a real Better Auth and an in-process Postgres, minus the Google click. */
describe("MCP OAuth: authorize, consent, token, verify", () => {
  let harness: Harness;
  let auth: Auth;
  let owners: Set<string>;
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    harness = await createTestDb();
    owners = new Set(["ryan@example.com"]);
    auth = createAuth({
      db: harness.db,
      secret: SECRET,
      baseURL: BASE,
      google: { clientId: "id", clientSecret: "secret" },
      ownerEmails: () => parseOwnerEmails([...owners].join(",")),
      secureCookies: false,
      mcpOAuth: { resource: RESOURCE, clientHosts: ["claude.ai"] },
    });
    const ctx = await auth.$context;
    const { user } = await ctx.internalAdapter.createOAuthUser(
      { email: "ryan@example.com", name: "Ryan", emailVerified: true },
      { accountId: "g-ryan", providerId: "google" },
    );
    userId = user.id;
    const session = await ctx.internalAdapter.createSession(user.id);
    // Better Auth's signed session cookie: the token, then its HMAC-SHA256 (base64), URL-encoded together.
    const signature = createHmac("sha256", SECRET).update(session.token).digest("base64");
    cookie = `rk-admin.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
    await ctx.adapter.create({
      model: "oauthClient",
      data: {
        clientId: CLIENT_ID,
        name: "Claude (test)",
        redirectUris: [REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        requirePKCE: true,
        scopes: [MCP_SCOPE, "offline_access"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    // What registering through Claude's published identity does for a new client: link it to the MCP URL.
    await ctx.adapter.create({
      model: "oauthClientResource",
      data: { clientId: CLIENT_ID, resourceId: RESOURCE, createdAt: new Date() },
    });
  });

  afterEach(async () => {
    await harness.client.close();
  });

  const call = (path: string, init: RequestInit = {}) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        ...init,
        headers: { cookie, origin: BASE, ...(init.headers as Record<string, string>) },
        redirect: "manual",
      }),
    );

  async function authorize(scope = MCP_SCOPE, resource = RESOURCE) {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const query = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope,
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    const response = await call(`/oauth2/authorize?${query}`);
    return { verifier, response };
  }

  async function approve(consentLocation: string) {
    const oauthQuery = new URL(consentLocation, BASE).search.slice(1);
    const response = await call("/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    });
    return (await response.json()) as { redirect: boolean; url: string };
  }

  async function exchange(code: string, verifier: string) {
    const response = await call("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function authenticator() {
    const { baseURL } = await auth.$context;
    return createOAuthAuthenticator({
      issuer: baseURL,
      resource: RESOURCE,
      jwksUrl: `${baseURL}/jwks`,
      scope: MCP_SCOPE,
      isOwner: async (id) => id === userId && owners.has("ryan@example.com"),
      // Keys come straight from the auth instance: the test has no HTTP server to fetch them from.
      verify: (token, opts) =>
        verifyBearerToken(token, { ...opts, jwksFetch: () => auth.api.getJwks() as never }),
    });
  }

  const bearer = (token: string) =>
    new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${token}` } });

  async function issueToken() {
    const { verifier, response } = await authorize();
    const consent = await approve(response.headers.get("location") ?? "");
    const code = new URL(consent.url).searchParams.get("code") ?? "";
    const token = await exchange(code, verifier);
    return token.body.access_token as string;
  }

  test("a signed-in owner is sent to the consent page, not straight through", async () => {
    const { response } = await authorize();

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", BASE);
    expect(location.pathname).toBe("/consent");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("sig")).toBeTruthy();
  });

  test("a signed-out visitor is sent to /login, carrying the signed request", async () => {
    cookie = "";
    const { response } = await authorize();
    const location = new URL(response.headers.get("location") ?? "", BASE);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("sig")).toBeTruthy();
    expect(location.searchParams.get("ba_param")).toBeTruthy();
  });

  test("consent returns an authorization code to the client's redirect URI with the state", async () => {
    const { response } = await authorize();
    const consent = await approve(response.headers.get("location") ?? "");
    const back = new URL(consent.url);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("xyz");
  });

  test("the token the client receives is accepted by the MCP and identifies the owner", async () => {
    const token = await issueToken();
    expect(token).toBeTruthy();
    const principal = await (await authenticator()).authenticate(bearer(token));
    expect(principal).toMatchObject({ actor: "mcp", ownerId: userId });
  });

  test("access tokens are short-lived", async () => {
    const { verifier, response } = await authorize();
    const consent = await approve(response.headers.get("location") ?? "");
    const token = await exchange(new URL(consent.url).searchParams.get("code") ?? "", verifier);
    expect(token.body.expires_in).toBe(15 * 60);
  });

  test("the MCP stops accepting the token the moment the person leaves the owner list", async () => {
    const token = await issueToken();
    const mcp = await authenticator();
    expect(await mcp.authenticate(bearer(token))).not.toBeNull();
    owners.delete("ryan@example.com");
    expect(await mcp.authenticate(bearer(token))).toBeNull();
  });

  test("a token issued for a different resource is not accepted", async () => {
    const token = await issueToken();
    const { baseURL } = await auth.$context;
    const otherResource = createOAuthAuthenticator({
      issuer: baseURL,
      resource: "https://other.example.test/mcp",
      jwksUrl: `${baseURL}/jwks`,
      scope: MCP_SCOPE,
      isOwner: async () => true,
      verify: (t, opts) => verifyBearerToken(t, { ...opts, jwksFetch: () => auth.api.getJwks() as never }),
    });
    expect(await otherResource.authenticate(bearer(token))).toBeNull();
  });

  test("a redirect URI the client did not register is never redirected to", async () => {
    const query = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: "https://evil.example/steal",
      response_type: "code",
      scope: MCP_SCOPE,
      state: "xyz",
      code_challenge: b64url(createHash("sha256").update("v").digest()),
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const response = await call(`/oauth2/authorize?${query}`);
    expect(response.headers.get("location") ?? "").not.toContain("evil.example");
  });

  test("a request for a resource the client is not linked to is refused", async () => {
    const { response } = await authorize(MCP_SCOPE, "https://other.example.test/mcp");
    expect(response.headers.get("location") ?? "").not.toContain("/consent");
  });

  test("a garbled or foreign token is refused", async () => {
    const mcp = await authenticator();
    expect(await mcp.authenticate(bearer("not.a.jwt"))).toBeNull();
    expect(await mcp.authenticate(bearer(randomBytes(32).toString("hex")))).toBeNull();
  });

  test("a code cannot be redeemed with the wrong PKCE verifier", async () => {
    const { response } = await authorize();
    const consent = await approve(response.headers.get("location") ?? "");
    const token = await exchange(
      new URL(consent.url).searchParams.get("code") ?? "",
      b64url(randomBytes(32)),
    );
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(token.body.access_token).toBeUndefined();
  });

  test("a session JWT from /token is not available to mint MCP tokens", async () => {
    const response = await call("/token");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("the discovery endpoint advertises PKCE and the issuer", async () => {
    const { baseURL } = await auth.$context;
    const response = await auth.handler(new Request(`${BASE}/api/auth/.well-known/oauth-authorization-server`));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(baseURL);
    expect(body.code_challenge_methods_supported).toContain("S256");
  });
});
