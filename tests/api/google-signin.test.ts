import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APIError } from "better-auth/api";
import { staff } from "@/db/schema";
import { createWorld, type World } from "../availability/setup";

const state = vi.hoisted(() => ({
  db: null as unknown,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ OWNER_EMAILS: "ryan@example.com" }) }));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { signInSocial: state.signIn, signOut: state.signOut } }),
}));

import { POST as signIn } from "@/app/api/v1/auth/google/route";
import { POST as signOut } from "@/app/api/v1/auth/signout/route";

let w: World;
const body = (payload: unknown) =>
  new Request("http://localhost/api/v1/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const ID_TOKEN = "x".repeat(60);

beforeEach(async () => {
  w = await createWorld();
  state.db = w.db;
  state.signIn.mockReset();
  state.signOut.mockReset();
});
afterEach(async () => {
  await w.t.client.close();
});

function signedIn(email: string, token: string | null = "signed.token") {
  state.signIn.mockResolvedValue({
    headers: new Headers(token ? { "set-auth-token": token } : {}),
    response: { user: { id: "user-1", email, name: "Ryan" } },
  });
}

describe("POST /api/v1/auth/google", () => {
  test("the owner gets a token, their role and staff id", async () => {
    signedIn("ryan@example.com");
    const res = await signIn(body({ idToken: ID_TOKEN, nonce: "n1" }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      token: "signed.token",
      role: "owner",
      user: { email: "ryan@example.com" },
    });
    expect(data.staffId).toBeTruthy();
    expect(state.signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          provider: "google",
          idToken: { token: ID_TOKEN, nonce: "n1" },
        }),
        returnHeaders: true,
      }),
    );
  });

  test("an active stylist signs in as a stylist", async () => {
    await w.db.insert(staff).values({ name: "Mia", email: "mia@example.com", role: "stylist" });
    signedIn("mia@example.com");
    const { data } = await (await signIn(body({ idToken: ID_TOKEN }))).json();
    expect(data.role).toBe("stylist");
  });

  test("a deactivated stylist is turned away", async () => {
    await w.db
      .insert(staff)
      .values({ name: "Mia", email: "mia@example.com", role: "stylist", active: false });
    signedIn("mia@example.com");
    const res = await signIn(body({ idToken: ID_TOKEN }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("not_authorised");
  });

  test("Better Auth refusing the identity is a 401 that does not leak why", async () => {
    state.signIn.mockRejectedValue(new APIError("UNAUTHORIZED", { message: "internal detail" }));
    const res = await signIn(body({ idToken: ID_TOKEN }));
    expect(res.status).toBe(401);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("sign_in_refused");
    expect(text).not.toContain("internal detail");
  });

  test("no token header means no sign-in", async () => {
    signedIn("ryan@example.com", null);
    expect((await signIn(body({ idToken: ID_TOKEN }))).status).toBe(401);
  });

  test("a missing or tiny idToken is a 422; bad JSON is a 400", async () => {
    expect((await signIn(body({}))).status).toBe(422);
    expect((await signIn(body({ idToken: "short" }))).status).toBe(422);
    expect((await signIn(body("{"))).status).toBe(400);
    expect(state.signIn).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/auth/signout", () => {
  test("signs out, and still succeeds when the session is already gone", async () => {
    state.signOut.mockResolvedValue({ success: true });
    expect((await signOut(new Request("http://localhost/x", { method: "POST" }))).status).toBe(200);
    state.signOut.mockRejectedValue(new Error("no session"));
    const res = await signOut(new Request("http://localhost/x", { method: "POST" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ signedOut: true });
  });
});
