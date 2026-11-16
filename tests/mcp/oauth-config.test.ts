import { describe, expect, it } from "vitest";
import { isAllowedClientUrl } from "@/server/auth/auth";
import { DEFAULT_CLIENT_HOSTS, readMcpOAuthConfig } from "@/server/auth/mcp-oauth-config";

describe("readMcpOAuthConfig", () => {
  it("is off unless MCP_PUBLIC_URL is set", () => {
    expect(readMcpOAuthConfig({})).toBeUndefined();
    expect(readMcpOAuthConfig({ MCP_PUBLIC_URL: "  " })).toBeUndefined();
  });

  it("uses the URL as the resource and Claude's hosts by default", () => {
    const config = readMcpOAuthConfig({ MCP_PUBLIC_URL: "https://mcp.hairmate.world/mcp" });
    expect(config?.resource).toBe("https://mcp.hairmate.world/mcp");
    expect(config?.clientHosts).toEqual(DEFAULT_CLIENT_HOSTS);
  });

  it("drops a trailing slash", () => {
    expect(readMcpOAuthConfig({ MCP_PUBLIC_URL: "https://mcp.hairmate.world/mcp/" })?.resource).toBe(
      "https://mcp.hairmate.world/mcp",
    );
  });

  it("takes a custom host list, lower-cased and trimmed", () => {
    const config = readMcpOAuthConfig({
      MCP_PUBLIC_URL: "https://mcp.hairmate.world/mcp",
      MCP_OAUTH_CLIENT_HOSTS: " Claude.AI , example.org ,",
    });
    expect(config?.clientHosts).toEqual(["claude.ai", "example.org"]);
  });

  it.each([
    "http://mcp.hairmate.world/mcp",
    "https://mcp.hairmate.world/mcp?x=1",
    "https://mcp.hairmate.world/mcp#frag",
    "https://user:pw@mcp.hairmate.world/mcp",
  ])("rejects %s", (url) => {
    expect(() => readMcpOAuthConfig({ MCP_PUBLIC_URL: url })).toThrow(/MCP_PUBLIC_URL/);
  });
});

describe("isAllowedClientUrl", () => {
  const hosts = new Set(["claude.ai"]);

  it("allows https on an allowed host", () => {
    expect(isAllowedClientUrl("https://claude.ai/oauth/metadata", hosts)).toBe(true);
    expect(isAllowedClientUrl("https://CLAUDE.AI/x", hosts)).toBe(true);
  });

  it.each([
    "http://claude.ai/x",
    "https://evil.example/x",
    "https://claude.ai.evil.example/x",
    "https://sub.claude.ai/x",
    "https://user@claude.ai/x",
    "https://claude.ai@evil.example/x",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(isAllowedClientUrl(url, hosts)).toBe(false);
  });
});
