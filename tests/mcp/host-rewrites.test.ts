import { describe, expect, it } from "vitest";
import { MCP_HOST, mcpHostRewrites } from "@/lib/mcp-host";

const hostCondition = [{ type: "host", value: MCP_HOST }];

describe("mcpHostRewrites", () => {
  it("serves /mcp on the MCP host from the existing /api/mcp route", () => {
    const [serve] = mcpHostRewrites();
    expect(serve).toEqual({ source: "/mcp", has: hostCondition, destination: "/api/mcp" });
  });

  it("answers everything else on the MCP host with a not-found page, so the admin app is not exposed", () => {
    const [, lockdown] = mcpHostRewrites();
    expect(lockdown.has).toEqual(hostCondition);
    expect(lockdown.destination).toBe("/mcp-host-only");
  });

  it("limits both rules to the MCP host", () => {
    for (const rule of mcpHostRewrites()) expect(rule.has).toEqual(hostCondition);
  });

  it("does not catch /mcp or its own destinations in the lockdown rule", () => {
    const [, lockdown] = mcpHostRewrites();
    const catchAll = new RegExp(`^${lockdown.source.replace(/^\/:path\(/, "/(").replace(/\)$/, ")")}$`);
    expect(catchAll.test("/login")).toBe(true);
    expect(catchAll.test("/api/auth/session")).toBe(true);
    expect(catchAll.test("/mcp")).toBe(false);
    expect(catchAll.test("/api/mcp")).toBe(false);
    expect(catchAll.test("/mcp-host-only")).toBe(false);
    expect(catchAll.test("/.well-known/oauth-protected-resource/mcp")).toBe(false);
    expect(catchAll.test("/.well-known/oauth-authorization-server/api/auth")).toBe(true);
  });

  it("uses the production MCP hostname", () => {
    expect(MCP_HOST).toBe("mcp.hairmate.world");
  });
});
