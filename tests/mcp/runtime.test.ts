import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./harness";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => holder.db }));

const TOKEN = "r".repeat(40);
const KEY = randomBytes(32).toString("base64");
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  holder.db = h.t.db;
});
afterAll(async () => {
  await h.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(env: Record<string, string>) {
  vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import("@/server/mcp/runtime");
  return mod.createDefaultMcpHandlers;
}

const rpc = (name: string, args: Record<string, unknown>, token = TOKEN) =>
  new Request("https://book.example.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

const result = async (res: Response) => JSON.parse((await res.json()).result.content[0].text);

describe("createDefaultMcpHandlers (production wiring)", () => {
  test("authenticates from MCP_API_TOKEN and serves read tools from the database", async () => {
    const create = await load({ MCP_API_TOKEN: TOKEN, ENCRYPTION_KEY: KEY });
    const { POST } = create();
    const body = await result(await POST(rpc("list_services", {})));
    expect(body.count).toBe(2);
    expect((await POST(rpc("list_services", {}, "wrong-token"))).status).toBe(401);
  });

  test("write tools preview with ENCRYPTION_KEY set and say what is missing without it", async () => {
    const withKey = (await load({ MCP_API_TOKEN: TOKEN, ENCRYPTION_KEY: KEY }))();
    const args = { clientId: h.fx.clients.sam, note: "wired" };
    const preview = await result(await withKey.POST(rpc("add_client_note", args)));
    expect(preview.status).toBe("confirmation_required");

    vi.unstubAllEnvs();
    vi.resetModules();
    const noKey = (await load({ MCP_API_TOKEN: TOKEN, ENCRYPTION_KEY: "" }))();
    const refused = await result(await noKey.POST(rpc("add_client_note", args)));
    expect(refused.error).toMatchObject({ code: "precondition_failed" });
    expect(refused.error.message).toMatch(/ENCRYPTION_KEY/);
  });

  test("money tools follow the environment kill switch", async () => {
    const off = (await load({ MCP_API_TOKEN: TOKEN, ENCRYPTION_KEY: KEY }))();
    expect((await result(await off.POST(rpc("get_integration_status", {})))).mcp).toMatchObject({
      moneyToolsEnabled: false,
      maxMoneyCentsPerCall: 20000,
    });
    vi.unstubAllEnvs();
    vi.resetModules();
    const on = (
      await load({
        MCP_API_TOKEN: TOKEN,
        ENCRYPTION_KEY: KEY,
        MCP_MONEY_TOOLS_ENABLED: "true",
        MCP_MAX_MONEY_CENTS: "1234",
      })
    )();
    expect((await result(await on.POST(rpc("get_integration_status", {})))).mcp).toMatchObject({
      moneyToolsEnabled: true,
      maxMoneyCentsPerCall: 1234,
    });
  });

  test("is unavailable (503) until a token is configured, and an authenticator can be swapped in", async () => {
    const create = await load({ MCP_API_TOKEN: "" });
    expect((await create().POST(rpc("list_services", {}))).status).toBe(503);
    const swapped = create({
      getAuthenticator: () => ({
        authenticate: () => ({ actor: "mcp", ownerId: "oauth-user", tokenId: "o1" }),
      }),
    });
    expect((await swapped.POST(rpc("list_services", {}, "anything"))).status).toBe(200);
  });

  test("limits the rate of failed logins and of requests using the configured numbers", async () => {
    const create = await load({ MCP_API_TOKEN: TOKEN, MCP_RATE_LIMIT_PER_MIN: "2" });
    const { POST } = create();
    expect((await POST(rpc("list_services", {}))).status).toBe(200);
    expect((await POST(rpc("list_services", {}))).status).toBe(200);
    expect((await POST(rpc("list_services", {}))).status).toBe(429);
    let last = 0;
    for (let i = 0; i < 11; i += 1) last = (await POST(rpc("list_services", {}, "bad"))).status;
    expect(last).toBe(429);
  });
});
