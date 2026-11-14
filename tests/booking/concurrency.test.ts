import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { booking } from "@/db/schema";
import { SlotTakenError, createHold } from "@/server/booking";
import { isExclusionViolation, pgErrorCode } from "@/server/booking/errors";
import { addBooking, createWorld, local, type World } from "../availability/setup";
import { CLIENT, hold, holdInput, opts } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("createHold under concurrency", () => {
  test("two simultaneous holds on the same slot: exactly one wins, the other gets SlotTakenError", async () => {
    const a = { ...CLIENT, email: "a@example.com", phone: "0412 345 678" };
    const b = { ...CLIENT, email: "b@example.com", phone: "0433 111 222" };

    const results = await Promise.allSettled([
      createHold(w.db, holdInput(w, { client: a }), opts),
      createHold(w.db, holdInput(w, { client: b }), opts),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SlotTakenError);
    expect(await w.db.select().from(booking)).toHaveLength(1);
  });

  test("many simultaneous holds on one slot still yield a single booking", async () => {
    const attempts = Array.from({ length: 5 }, (_, i) =>
      createHold(
        w.db,
        holdInput(w, {
          client: {
            ...CLIENT,
            email: `c${i}@example.com`,
            phone: `04${i}0 111 222`.replace(/ /g, ""),
          },
        }),
        opts,
      ),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .every((r) => r.reason instanceof SlotTakenError),
    ).toBe(true);
  });

  test("concurrent holds on different slots all succeed", async () => {
    const starts = ["2026-11-02T10:00", "2026-11-02T11:00", "2026-11-02T12:00"];
    const results = await Promise.all(
      starts.map((s, i) =>
        hold(w, {
          start: local(s),
          client: {
            ...CLIENT,
            email: `d${i}@example.com`,
            phone: `04${i}0 111 222`.replace(/ /g, ""),
          },
        }),
      ),
    );
    expect(new Set(results.map((r) => r.bookingId)).size).toBe(3);
  });
});

describe("exclusion violation handling", () => {
  test("recognises the real Postgres error raised by the no_overlap constraint", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    const error = await addBooking(
      w.db,
      w,
      local("2026-11-02T10:30"),
      local("2026-11-02T11:15"),
    ).catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23P01");
    expect(isExclusionViolation(error)).toBe(true);
  });

  test("ignores other errors", () => {
    expect(isExclusionViolation(new Error("boom"))).toBe(false);
    expect(isExclusionViolation({ code: "23505" })).toBe(false);
    expect(isExclusionViolation(undefined)).toBe(false);
    expect(isExclusionViolation({ cause: { cause: { code: "23P01" } } })).toBe(true);
  });
});
