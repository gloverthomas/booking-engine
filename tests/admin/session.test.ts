import { beforeEach, describe, expect, test, vi } from "vitest";

const fakeDb = { fake: true };
vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));

const { FakeDenied, requireAccess } = vi.hoisted(() => {
  class Denied extends Error {
    constructor(readonly permission: string) {
      super(`Not allowed: ${permission}`);
      this.name = "AccessDeniedError";
    }
  }
  return { FakeDenied: Denied, requireAccess: vi.fn() };
});
vi.mock("@/server/auth/access", () => ({
  requireAccess: (permission: string) => requireAccess(permission),
  AccessDeniedError: FakeDenied,
}));

import {
  getCalendarCommandContext,
  getCalendarReadContext,
  getCommandContext,
  getReadContext,
} from "@/server/admin/session";
import { realDomain } from "@/server/admin/domain";

const owner = { userId: "u1", email: "ryan@example.com", staffId: null, role: "owner" };
const stylist = { userId: "u2", email: "alex@example.com", staffId: "s2", role: "stylist" };

describe("session helpers", () => {
  beforeEach(() => {
    requireAccess.mockReset();
  });

  test("owner commands get an owner actor, the access context and the real domain", async () => {
    requireAccess.mockResolvedValue(owner);
    const ctx = await getCommandContext("booking.edit");
    expect(ctx).toEqual({
      db: fakeDb,
      actor: "owner:u1",
      access: { role: "owner", staffId: null },
      domain: realDomain,
    });
    expect(requireAccess).toHaveBeenCalledWith("booking.edit");
  });

  test("everyone else acts as staff:<userId>", async () => {
    requireAccess.mockResolvedValue(stylist);
    const ctx = await getCommandContext("booking.edit");
    expect(ctx.actor).toBe("staff:u2");
    expect(ctx.access).toEqual({ role: "stylist", staffId: "s2" });
  });

  test("read context carries the viewer's capabilities", async () => {
    requireAccess.mockResolvedValue(stylist);
    const ctx = await getReadContext("clients.view");
    expect(ctx).toMatchObject({
      db: fakeDb,
      actor: "staff:u2",
      access: { role: "stylist", staffId: "s2" },
      caps: { seesAll: false, refund: false, mergeClients: false, createBookings: true },
    });
  });

  test("tries the alternative permission when the first is denied", async () => {
    requireAccess.mockImplementation(async (permission: string) => {
      if (permission === "calendar.viewAll") throw new FakeDenied(permission);
      return stylist;
    });
    const ctx = await getCalendarReadContext();
    expect(ctx.access.role).toBe("stylist");
    expect(requireAccess.mock.calls.map((c) => c[0])).toEqual([
      "calendar.viewAll",
      "calendar.viewOwn",
    ]);
    expect((await getCalendarCommandContext()).actor).toBe("staff:u2");
  });

  test("rethrows the denial when no permission is granted", async () => {
    requireAccess.mockImplementation(async (permission: string) => {
      throw new FakeDenied(permission);
    });
    await expect(getReadContext("calendar.viewAll", "calendar.viewOwn")).rejects.toBeInstanceOf(
      FakeDenied,
    );
  });

  test("propagates a redirect untouched without trying alternatives", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    requireAccess.mockRejectedValue(redirect);
    await expect(getCommandContext("booking.edit", "booking.create")).rejects.toBe(redirect);
    await expect(getReadContext("clients.view")).rejects.toBe(redirect);
    expect(requireAccess).toHaveBeenCalledTimes(2);
  });
});
