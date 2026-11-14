import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { runAction, userFacingMessage } from "@/server/admin/action";
import { AdminError, isOverlapError } from "@/server/admin/errors";

describe("userFacingMessage", () => {
  test("passes AdminError and short domain errors through", () => {
    expect(userFacingMessage(new AdminError("Nope"))).toBe("Nope");
    expect(userFacingMessage(new Error("That slot was just taken"))).toBe(
      "That slot was just taken",
    );
  });

  test("uses the first validation issue for zod errors", () => {
    const result = z.object({ a: z.string().min(1, "A is required") }).safeParse({ a: "" });
    expect(userFacingMessage(result.error)).toBe("A is required");
  });

  test("maps the double booking constraint to a friendly message", () => {
    const pg = Object.assign(new Error("conflicting key value violates exclusion constraint"), {
      code: "23P01",
    });
    expect(userFacingMessage(pg)).toMatch(/overlaps another booking/);
    expect(userFacingMessage(new Error("wrapper", { cause: pg }))).toMatch(/overlaps/);
  });

  test("hides database errors, long messages and non-errors", () => {
    const generic = "Something went wrong. Please try again.";
    expect(userFacingMessage(Object.assign(new Error("secret"), { code: "42P01" }))).toBe(generic);
    expect(
      userFacingMessage(new Error("Failed query: select * from client where email = $1")),
    ).toBe(generic);
    expect(userFacingMessage(new Error("x".repeat(500)))).toBe(generic);
    expect(userFacingMessage("weird")).toBe(generic);
  });
});

describe("isOverlapError", () => {
  test("detects constraint name, code and cause chains, and is cycle safe", () => {
    expect(isOverlapError(new Error('violates "no_overlap"'))).toBe(true);
    expect(isOverlapError(new Error("other"))).toBe(false);
    expect(isOverlapError(null)).toBe(false);
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isOverlapError(a)).toBe(false);
  });
});

describe("runAction", () => {
  test("wraps a result", async () => {
    expect(await runAction("x", async () => 5)).toEqual({ ok: true, data: 5 });
  });

  test("turns thrown errors into failures and logs only the unexpected ones", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runAction("x", async () => Promise.reject(new AdminError("bad")))).toEqual({
        ok: false,
        error: "bad",
      });
      expect(write).not.toHaveBeenCalled();

      const result = await runAction("x", async () => Promise.reject(new Error("kaput")));
      expect(result).toEqual({ ok: false, error: "kaput" });
      expect(write).toHaveBeenCalledOnce();
      expect(String(write.mock.calls[0][0])).toContain("admin action failed");
    } finally {
      write.mockRestore();
    }
  });
});
