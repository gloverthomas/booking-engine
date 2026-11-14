import { describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "@/server/crypto";

const key = randomBytes(32).toString("base64");

describe("encryptJson / decryptJson", () => {
  test("round-trips structured data", () => {
    const value = { access_token: "a", refresh_token: "r", expires_at: 123 };
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value);
  });

  test("uses a fresh IV so equal inputs encrypt differently", () => {
    expect(encryptJson({ a: 1 }, key)).not.toBe(encryptJson({ a: 1 }, key));
  });

  test("fails to decrypt with the wrong key or tampered data", () => {
    const encrypted = encryptJson({ a: 1 }, key);
    expect(() => decryptJson(encrypted, randomBytes(32).toString("base64"))).toThrow();
    const tampered = Buffer.from(encrypted, "base64");
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptJson(tampered.toString("base64"), key)).toThrow();
  });

  test("rejects a key of the wrong length", () => {
    expect(() => encryptJson({}, Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });
});
