import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBearerAuthenticator, hashToken, type McpAuthenticator } from "@/server/mcp/auth";
import { createMcpRouteHandlers } from "@/server/mcp/http";
import { createRateLimiter } from "@/server/mcp/rate-limit";
import { createHarness, type Harness } from "./harness";

const TOKEN = "k".repeat(48);
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

function handlers(
  overrides: {
    auth?: McpAuthenticator | null;
    requests?: number;
    resourceMetadataUrl?: string;
  } = {},
) {
  const auth =
    overrides.auth === undefined
      ? createBearerAuthenticator({ tokenHashes: [hashToken(TOKEN)], ownerId: "ryan" })
      : overrides.auth;
  return createMcpRouteHandlers({
    getAuthenticator: () => auth,
    getDeps: () => h.deps,
    requestLimiter: createRateLimiter({ limit: overrides.requests ?? 100, windowMs: 60_000 }),
    failedAuthLimiter: createRateLimiter({ limit: 3, windowMs: 60_000 }),
    resourceMetadataUrl: overrides.resourceMetadataUrl,
  });
}

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://book.example.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
};

describe("POST /api/mcp (stateless Streamable HTTP)", () => {
  test("initialises, lists tools and calls a tool, all without sessions", async () => {
    const { POST } = handlers();
    const init = await POST(rpc(initialize));
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe("booking-engine");
    expect(initBody.result.instructions).toMatch(/untrusted/);

    const list = await (await POST(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    expect(list.result.tools).toHaveLength(18);

    const called = await (
      await POST(
        rpc({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_services", arguments: {} },
        }),
      )
    ).json();
    expect(called.result.isError).toBe(false);
    expect(JSON.parse(called.result.content[0].text).count).toBe(2);
    expect(called.result.structuredContent.count).toBe(2);
  });

  test("a full preview and confirm round trip over HTTP, acting as the authenticated principal", async () => {
    const { POST } = handlers();
    const call = async (args: Record<string, unknown>) => {
      const res = await POST(
        rpc({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "add_client_note", arguments: args },
        }),
      );
      return JSON.parse((await res.json()).result.content[0].text);
    };
    const args = { clientId: h.fx.clients.sam, note: "over http" };
    const preview = await call(args);
    expect(preview.status).toBe("confirmation_required");
    const done = await call({ ...args, confirmToken: preview.confirmToken });
    expect(done.status).toBe("executed");
    const rows = await h.t.db.query.auditLog.findMany({
      where: (a, { eq }) => eq(a.action, "mcp.add_client_note"),
    });
    expect(rows.at(-1)?.data).toMatchObject({ ownerId: "ryan" });
  });

  test("tool errors come back as results, not transport errors", async () => {
    const { POST } = handlers();
    const res = await POST(
      rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_booking", arguments: { bookingId: "nope" } },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe("invalid_input");
  });

  test("rejects requests without valid credentials with a Bearer challenge", async () => {
    const { POST } = handlers({
      resourceMetadataUrl: "https://book.example.test/.well-known/oauth-protected-resource",
    });
    const none = await POST(rpc(initialize, { authorization: "" }));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      'Bearer realm="booking-engine-mcp", resource_metadata="https://book.example.test/.well-known/oauth-protected-resource"',
    );
    const wrong = await handlers().POST(rpc(initialize, { authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe('Bearer realm="booking-engine-mcp"');
    expect(await wrong.json()).toMatchObject({ error: { message: "Authentication required." } });
  });

  test("throttles repeated failed logins per client address", async () => {
    const { POST } = handlers();
    const bad = () =>
      POST(
        rpc(initialize, {
          authorization: "Bearer nope",
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        }),
      );
    expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(401);
    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different address is unaffected, and so is a good token.
    expect(
      (await POST(rpc(initialize, { authorization: "Bearer nope", "x-real-ip": "198.51.100.9" })))
        .status,
    ).toBe(401);
    expect((await POST(rpc(initialize, { "x-forwarded-for": "203.0.113.7" }))).status).toBe(200);
  });

  test("fails closed when no authenticator is configured", async () => {
    const res = await handlers({ auth: null }).POST(rpc(initialize));
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toMatch(/not configured/);
  });

  test("accepts any McpAuthenticator, which is how OAuth will plug in", async () => {
    const seen: string[] = [];
    const oauthLike: McpAuthenticator = {
      async authenticate(request) {
        seen.push(request.headers.get("authorization") ?? "");
        return { actor: "mcp", ownerId: "google-owner", tokenId: "oauth-1" };
      },
    };
    const res = await handlers({ auth: oauthLike }).POST(
      rpc(initialize, { authorization: "Bearer eyJ.fake.jwt" }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer eyJ.fake.jwt"]);
  });

  test("rate limits per token", async () => {
    const { POST } = handlers({ requests: 2 });
    expect((await POST(rpc(initialize))).status).toBe(200);
    expect((await POST(rpc(initialize))).status).toBe(200);
    const limited = await POST(rpc(initialize));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("there are no sessions or event streams to open or close", async () => {
    const { GET, DELETE } = handlers();
    for (const method of [GET, DELETE]) {
      const res = await method();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  test("rejects oversized and malformed bodies", async () => {
    const { POST } = handlers();
    const big = await POST(
      rpc(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(300_000) }),
      ),
    );
    expect(big.status).toBe(413);
    const garbage = await POST(rpc("{not json"));
    expect(garbage.status).toBe(400);
  });
});
