import { describe, expect, test } from "vitest";
import { signedOAuthQuery } from "@/server/auth/oauth-query";

describe("signedOAuthQuery", () => {
  const signed = {
    client_id: "https://claude.ai/meta",
    scope: "mcp",
    exp: "1900000000",
    sig: "abc",
    ba_param: ["client_id", "exp", "ba_param", "scope"],
  };

  test("keeps the signature, the signed names and the parameters they list", () => {
    const query = new URLSearchParams(signedOAuthQuery(signed));
    expect(query.get("sig")).toBe("abc");
    expect(query.get("client_id")).toBe("https://claude.ai/meta");
    expect(query.get("scope")).toBe("mcp");
    expect(query.get("exp")).toBe("1900000000");
    expect(query.getAll("ba_param")).toHaveLength(4);
  });

  test("leaves out parameters that were not signed, like our own error code", () => {
    const query = new URLSearchParams(signedOAuthQuery({ ...signed, error: "unable_to_start", extra: "x" }));
    expect(query.has("error")).toBe(false);
    expect(query.has("extra")).toBe(false);
  });

  test("is undefined for an ordinary visit to /login", () => {
    expect(signedOAuthQuery({})).toBeUndefined();
    expect(signedOAuthQuery({ error: "not_authorised" })).toBeUndefined();
  });

  test("is undefined without a signature or without the signed names", () => {
    expect(signedOAuthQuery({ client_id: "x", ba_param: ["client_id"] })).toBeUndefined();
    expect(signedOAuthQuery({ client_id: "x", sig: "abc" })).toBeUndefined();
  });
});
