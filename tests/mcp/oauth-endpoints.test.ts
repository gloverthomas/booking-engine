import { describe, expect, it } from "vitest";
import { MCP_SCOPE } from "@/server/auth/auth";
import { mcpOAuthEndpoints, mcpProtectedResourceDocument } from "@/server/mcp/oauth-runtime";

const APP_URL = "https://app.hairmate.world";
const MCP_PUBLIC_URL = "https://mcp.hairmate.world/mcp";

describe("mcpOAuthEndpoints", () => {
  it("returns null when MCP_PUBLIC_URL is omitted, undefined, or whitespace", () => {
    expect(mcpOAuthEndpoints({ APP_URL })).toBeNull();
    expect(mcpOAuthEndpoints({ APP_URL, MCP_PUBLIC_URL: undefined })).toBeNull();
    expect(mcpOAuthEndpoints({ APP_URL, MCP_PUBLIC_URL: "   " })).toBeNull();
  });

  it("returns null when APP_URL is missing or empty", () => {
    expect(mcpOAuthEndpoints({ MCP_PUBLIC_URL })).toBeNull();
    expect(mcpOAuthEndpoints({ APP_URL: "", MCP_PUBLIC_URL })).toBeNull();
  });

  it("binds tokens to the trimmed MCP URL and publishes issuer URLs on the app origin", () => {
    expect(
      mcpOAuthEndpoints({
        APP_URL: "https://app.hairmate.world/admin?x=1",
        MCP_PUBLIC_URL: "  https://mcp.hairmate.world/mcp  ",
      }),
    ).toEqual({
      resource: "https://mcp.hairmate.world/mcp",
      issuer: "https://app.hairmate.world/api/auth",
      jwksUrl: "https://app.hairmate.world/api/auth/jwks",
      metadataUrl: "https://mcp.hairmate.world/.well-known/oauth-protected-resource/mcp",
    });
  });
});

describe("mcpProtectedResourceDocument", () => {
  it("returns null while OAuth is off", () => {
    expect(mcpProtectedResourceDocument({ APP_URL })).toBeNull();
  });

  it("names the app issuer and the mcp scope", () => {
    expect(mcpProtectedResourceDocument({ APP_URL, MCP_PUBLIC_URL })).toEqual({
      resource: "https://mcp.hairmate.world/mcp",
      authorization_servers: ["https://app.hairmate.world/api/auth"],
      bearer_methods_supported: ["header"],
      scopes_supported: [MCP_SCOPE],
    });
  });
});
