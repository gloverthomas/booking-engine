import { beforeEach, describe, expect, test, vi } from "vitest";

const getReadContext = vi.fn();
vi.mock("@/server/admin/session", () => ({
  getReadContext: (...permissions: string[]) => getReadContext(...permissions),
}));

import { withReadContext } from "@/server/admin/api";
import { AdminError } from "@/server/admin/errors";

const ctx = { db: {}, actor: "staff:u2", access: { role: "stylist", staffId: "s1" }, caps: {} };

describe("withReadContext", () => {
  beforeEach(() => {
    getReadContext.mockReset();
  });

  test("runs the handler with the resolved context", async () => {
    getReadContext.mockResolvedValue(ctx);
    const response = await withReadContext(["clients.view"], async (c) => Response.json({ c }));
    expect(response.status).toBe(200);
    expect(getReadContext).toHaveBeenCalledWith("clients.view");
  });

  test("signed out (a redirect) is a 401 JSON error", async () => {
    getReadContext.mockImplementation(async () => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login" });
    });
    const response = await withReadContext(["clients.view"], async () => Response.json({}));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not signed in" });
  });

  test("a role without the permission is a 403", async () => {
    const denied = Object.assign(new Error("Not allowed: calendar.viewAll"), {
      name: "AccessDeniedError",
    });
    getReadContext.mockImplementation(async () => {
      throw denied;
    });
    const response = await withReadContext(["calendar.viewAll"], async () => Response.json({}));
    expect(response.status).toBe(403);
  });

  test("an AdminError from the handler (e.g. stylist without a profile) is a 403 with its message", async () => {
    getReadContext.mockResolvedValue(ctx);
    const response = await withReadContext(["clients.view"], async () => {
      throw new AdminError("Your login is not linked to a staff profile yet.");
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Your login is not linked to a staff profile yet.",
    });
  });

  test("an unexpected failure resolving access is a 500 that leaks nothing", async () => {
    getReadContext.mockImplementation(async () => {
      throw new Error("db password is hunter2");
    });
    const response = await withReadContext(["clients.view"], async () => Response.json({}));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });

  test("a failure resolving an AdminError is passed on as 403", async () => {
    getReadContext.mockImplementation(async () => {
      throw new AdminError("Not linked");
    });
    const response = await withReadContext(["clients.view"], async () => Response.json({}));
    expect(response.status).toBe(403);
  });
});
