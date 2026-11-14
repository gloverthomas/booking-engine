import { beforeEach, describe, expect, test, vi } from "vitest";

const fakeDb = { fake: true };
vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));
const requireOwner = vi.fn();
vi.mock("@/server/auth", () => ({ requireOwner: () => requireOwner() }));

import { getCommandContext, getReadContext } from "@/server/admin/session";
import { realDomain } from "@/server/admin/domain";

describe("session helpers", () => {
  beforeEach(() => {
    requireOwner.mockReset();
  });

  test("builds the owner actor and real domain for commands", async () => {
    requireOwner.mockResolvedValue({ userId: "u1", email: "ryan@example.com" });
    const ctx = await getCommandContext();
    expect(ctx).toEqual({ db: fakeDb, actor: "owner:u1", domain: realDomain });
  });

  test("read context carries db and actor", async () => {
    requireOwner.mockResolvedValue({ userId: "u2", email: "ryan@example.com" });
    expect(await getReadContext()).toEqual({ db: fakeDb, actor: "owner:u2" });
  });

  test("propagates an auth failure or redirect untouched", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    requireOwner.mockRejectedValue(redirect);
    await expect(getCommandContext()).rejects.toBe(redirect);
    await expect(getReadContext()).rejects.toBe(redirect);
  });
});
