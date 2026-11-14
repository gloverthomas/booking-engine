import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { makeManageToken, verifyManageToken } from "@/server/manage-token";

const key = randomBytes(32).toString("base64");
const id = "7b1c1c3e-6d0f-4d1e-9f27-0e3a5a1f9c11";

describe("manage token", () => {
  test("is deterministic and verifies back to the booking id", () => {
    const token = makeManageToken(id, key);
    expect(token).toBe(makeManageToken(id, key));
    expect(verifyManageToken(token, key)).toBe(id);
  });

  test("rejects tampered, foreign-key and malformed tokens", () => {
    const token = makeManageToken(id, key);
    expect(verifyManageToken(`${id}.AAAA`, key)).toBeNull();
    expect(verifyManageToken(token.replace(id, "other-booking"), key)).toBeNull();
    expect(verifyManageToken(token, randomBytes(32).toString("base64"))).toBeNull();
    expect(verifyManageToken("nodot", key)).toBeNull();
    expect(verifyManageToken("", key)).toBeNull();
  });
});
