import { verifyBearerToken } from "better-auth/oauth2";
import { bearerTokenFrom, type McpAuthenticator, type McpPrincipal } from "./auth";

type Verify = typeof verifyBearerToken;

export interface OAuthAuthenticatorOptions {
  /** The authorization server's issuer, e.g. https://app.hairmate.world/api/auth. */
  issuer: string;
  /** The MCP URL the token must be issued for (its `aud`), e.g. https://mcp.hairmate.world/mcp. */
  resource: string;
  /** Where the authorization server publishes its signing keys. */
  jwksUrl: string;
  /** The scope every token must carry. */
  scope: string;
  /**
   * Whether this user may still use the MCP, checked on every request. Access tokens cannot be revoked, so this
   * is what cuts someone off the moment they leave the owner list, ahead of their token expiring.
   */
  isOwner: (userId: string) => Promise<boolean>;
  /** Replaceable in tests. */
  verify?: Verify;
}

/**
 * Accepts an OAuth access token issued by our own authorization server for this MCP URL, and nothing else.
 *
 * Verified: signature (against the published keys), issuer, audience, expiry, `typ: at+jwt` (so a session
 * JWT cannot stand in for an access token), a client (`azp`), the `mcp` scope, and no sender constraint (a
 * DPoP-bound token is refused: we do not check proofs). Never throws for bad credentials, per McpAuthenticator.
 */
export function createOAuthAuthenticator(options: OAuthAuthenticatorOptions): McpAuthenticator {
  const verify = options.verify ?? verifyBearerToken;
  return {
    async authenticate(request): Promise<McpPrincipal | null> {
      const token = bearerTokenFrom(request);
      if (!token) return null;

      let claims;
      try {
        claims = await verify(token, {
          verifyOptions: {
            issuer: options.issuer,
            audience: options.resource,
            typ: "at+jwt",
            requiredClaims: ["azp"],
          },
          jwksUrl: options.jwksUrl,
          requiredScopes: [options.scope],
        });
      } catch {
        return null;
      }

      const userId = claims.sub;
      if (typeof userId !== "string" || userId === "") return null;
      if (!(await options.isOwner(userId))) return null;
      return { actor: "mcp", ownerId: userId, tokenId: `oauth:${userId}` };
    },
  };
}

/** The first authenticator that recognises the request wins. Nulls (an unconfigured method) are skipped. */
export function firstAuthenticator(
  ...authenticators: ReadonlyArray<McpAuthenticator | null | undefined>
): McpAuthenticator | null {
  const present = authenticators.filter((a): a is McpAuthenticator => Boolean(a));
  if (present.length === 0) return null;
  return {
    async authenticate(request) {
      for (const authenticator of present) {
        const principal = await authenticator.authenticate(request);
        if (principal) return principal;
      }
      return null;
    },
  };
}

/** RFC 9728 document telling a client which authorization server to use for this MCP URL. */
export function protectedResourceMetadata(input: { resource: string; issuer: string; scope: string }) {
  return {
    resource: input.resource,
    authorization_servers: [input.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [input.scope],
  };
}

/** Where that document lives for a resource (RFC 9728 puts the resource's path after the well-known prefix). */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
