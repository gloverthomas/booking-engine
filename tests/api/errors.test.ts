import { notFound } from "next/navigation";
import { describe, expect, test } from "vitest";
import { ZodError, z } from "zod";
import { AdminError } from "@/server/admin/errors";
import { AuthNotConfiguredError } from "@/server/auth/config";
import { AccessDeniedError } from "@/server/auth/access-core";
import {
  BookingStateError,
  ClientBlockedError,
  NotFoundError,
  NotRosteredError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
  VipOnlyError,
} from "@/server/booking/errors";
import { ApiError, errorResponse, failure, ok } from "@/server/api/respond";

async function read(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("response envelope", () => {
  test("success is { data } and never cached", async () => {
    const res = ok({ a: 1 }, 201);
    expect(await read(res)).toEqual({ status: 201, body: { data: { a: 1 } } });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("failure is { error: { code, message } }", async () => {
    expect(await read(failure(418, { code: "teapot", message: "No" }))).toEqual({
      status: 418,
      body: { error: { code: "teapot", message: "No" } },
    });
  });
});

describe("errorResponse", () => {
  const cases: Array<[string, unknown, number, string]> = [
    ["ApiError", new ApiError(413, "too_large", "Too big"), 413, "too_large"],
    [
      "a redirect to login",
      Object.assign(new Error("r"), { digest: "NEXT_REDIRECT;replace;/login" }),
      401,
      "unauthenticated",
    ],
    ["a missing permission", new AccessDeniedError("booking.create"), 403, "forbidden"],
    ["not found", new NotFoundError("gone"), 404, "not_found"],
    ["a taken slot", new SlotTakenError(), 409, "slot_taken"],
    ["a database overlap", Object.assign(new Error("x"), { code: "23P01" }), 409, "slot_taken"],
    ["not rostered", new NotRosteredError(), 409, "not_rostered"],
    ["a booking in the wrong state", new BookingStateError("already done"), 409, "invalid_state"],
    ["a changed policy", new PolicyVersionError("2", "1"), 409, "policy_changed"],
    ["a blocked client", new ClientBlockedError(), 403, "not_allowed"],
    ["a VIP-only service", new VipOnlyError("Colour"), 403, "not_allowed"],
    ["a validation error", new ValidationError("Bad"), 422, "invalid_request"],
    ["an AdminError", new AdminError("Not today"), 400, "rejected"],
    [
      "sign-in not set up",
      new AuthNotConfiguredError("GOOGLE_CLIENT_ID missing"),
      503,
      "auth_not_configured",
    ],
  ];

  test.each(cases)("%s", async (_name, error, status, code) => {
    const { status: s, body } = await read(errorResponse(error));
    expect(s).toBe(status);
    expect(body.error.code).toBe(code);
  });

  test("a zod error lists the fields", async () => {
    let error: unknown;
    try {
      z.object({ a: z.string(), b: z.object({ c: z.number() }) }).parse({ b: {} });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZodError);
    const { status, body } = await read(errorResponse(error));
    expect(status).toBe(422);
    expect(Object.keys(body.error.fields)).toEqual(["a", "b.c"]);
  });

  test("an unknown error is a 500 that leaks nothing", async () => {
    const { status, body } = await read(errorResponse(new Error("password is hunter2")));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  test("Next's own control flow (notFound, prerender bailouts) is rethrown, never turned into a 500", () => {
    let thrown: unknown;
    try {
      notFound();
    } catch (e) {
      thrown = e;
    }
    expect(() => errorResponse(thrown)).toThrow();
  });

  test("a non-error throw is also a 500", async () => {
    expect((await read(errorResponse("boom"))).status).toBe(500);
  });
});
