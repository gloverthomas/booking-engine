import { describe, expect, it, vi } from "vitest";
import { hashToken, createBearerAuthenticator } from "@/server/mcp/auth";
import {
  createOAuthAuthenticator,
  firstAuthenticator,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from "@/server/mcp/oauth";

const options = {
  issuer: "https://app.hairmate.world/api/auth",
  resource: "https://mcp.hairmate.world/mcp",
  jwksUrl: "https://app.hairmate.world/api/auth/jwks",
  scope: "mcp",
};

const request = (authorization?: string) =>
  new Request("https://mcp.hairmate.world/mcp", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

describe("createOAuthAuthenticator", () => {
  it("accepts a verified token from a current owner and returns that owner", async () => {
    const verify = vi.fn().mockResolvedValue({ sub: "user-1", azp: "claude", scope: "mcp" });
    const auth = createOAuthAuthenticator({ ...options, isOwner: async () => true, verify });
    const principal = await auth.authenticate(request("Bearer jwt-token"));
    expect(principal).toEqual({ actor: "mcp", ownerId: "user-1", tokenId: "oauth:user-1" });
  });

  it("verifies issuer, audience, token type, client, scope and keys, and refuses sender-bound tokens by using the bearer verifier", async () => {
    const verify = vi.fn().mockResolvedValue({ sub: "user-1" });
    const auth = createOAuthAuthenticator({ ...options, isOwner: async () => true, verify });
    await auth.authenticate(request("Bearer jwt-token"));
    expect(verify).toHaveBeenCalledWith("jwt-token", {
      verifyOptions: {
        issuer: options.issuer,
        audience: options.resource,
        typ: "at+jwt",
        requiredClaims: ["azp"],
      },
      jwksUrl: options.jwksUrl,
      requiredScopes: ["mcp"],
    });
  });

  it("refuses a token that fails verification, without throwing", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("signature verification failed"));
    const auth = createOAuthAuthenticator({ ...options, isOwner: async () => true, verify });
    await expect(auth.authenticate(request("Bearer bad"))).resolves.toBeNull();
  });

  it("refuses a request with no bearer token without calling the verifier", async () => {
    const verify = vi.fn();
    const auth = createOAuthAuthenticator({ ...options, isOwner: async () => true, verify });
    await expect(auth.authenticate(request())).resolves.toBeNull();
    await expect(auth.authenticate(request("Basic abc"))).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses a verified token whose user is no longer an owner", async () => {
    const verify = vi.fn().mockResolvedValue({ sub: "user-2" });
    const isOwner = vi.fn().mockResolvedValue(false);
    const auth = createOAuthAuthenticator({ ...options, isOwner, verify });
    await expect(auth.authenticate(request("Bearer jwt"))).resolves.toBeNull();
    expect(isOwner).toHaveBeenCalledWith("user-2");
  });

  it.each([{}, { sub: "" }, { sub: 42 }])("refuses a token without a usable subject (%j)", async (claims) => {
    const verify = vi.fn().mockResolvedValue(claims);
    const isOwner = vi.fn().mockResolvedValue(true);
    const auth = createOAuthAuthenticator({ ...options, isOwner, verify });
    await expect(auth.authenticate(request("Bearer jwt"))).resolves.toBeNull();
    expect(isOwner).not.toHaveBeenCalled();
  });
});

describe("firstAuthenticator", () => {
  const staticToken = "s".repeat(40);
  const bearer = createBearerAuthenticator({ tokenHashes: [hashToken(staticToken)], ownerId: "owner" });
  const oauth = createOAuthAuthenticator({
    ...options,
    isOwner: async () => true,
    verify: vi.fn().mockRejectedValue(new Error("not a jwt")),
  });

  it("is null when nothing is configured", () => {
    expect(firstAuthenticator(null, undefined)).toBeNull();
  });

  it("falls through to the static token when the OAuth check does not recognise the request", async () => {
    const both = firstAuthenticator(oauth, bearer);
    const principal = await both?.authenticate(request(`Bearer ${staticToken}`));
    expect(principal?.ownerId).toBe("owner");
  });

  it("refuses a token neither method accepts", async () => {
    const both = firstAuthenticator(oauth, bearer);
    await expect(both?.authenticate(request("Bearer nope"))).resolves.toBeNull();
  });

  it("skips an unconfigured method", async () => {
    const only = firstAuthenticator(null, bearer);
    expect((await only?.authenticate(request(`Bearer ${staticToken}`)))?.ownerId).toBe("owner");
  });
});

describe("protected resource metadata", () => {
  it("points the client at the authorization server and the one scope", () => {
    expect(protectedResourceMetadata({ resource: options.resource, issuer: options.issuer, scope: "mcp" })).toEqual({
      resource: "https://mcp.hairmate.world/mcp",
      authorization_servers: ["https://app.hairmate.world/api/auth"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  });

  it("puts the resource's path after the well-known prefix", () => {
    expect(protectedResourceMetadataUrl("https://mcp.hairmate.world/mcp")).toBe(
      "https://mcp.hairmate.world/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceMetadataUrl("https://mcp.hairmate.world")).toBe(
      "https://mcp.hairmate.world/.well-known/oauth-protected-resource",
    );
  });
});
