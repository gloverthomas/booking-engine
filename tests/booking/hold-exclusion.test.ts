import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { booking } from "@/db/schema";
import { SlotTakenError, createHold } from "@/server/booking";
import { addBooking, createWorld, local, type World } from "../availability/setup";
import { holdInput, opts } from "./setup";

/**
 * In production the availability re-check and the insert can interleave with another connection, so
 * the DB constraint is the last line of defence. Simulate that by making the re-check "miss" an
 * existing booking, then assert the 23P01 from the constraint becomes a SlotTakenError.
 */
const hidden = vi.hoisted(() => ({ bookingId: undefined as string | undefined }));

vi.mock("@/server/availability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/availability")>();
  return {
    ...actual,
    searchAvailability: (
      db: Parameters<typeof actual.searchAvailability>[0],
      query: Parameters<typeof actual.searchAvailability>[1],
    ) => actual.searchAvailability(db, query, { excludeBookingId: hidden.bookingId }),
  };
});

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("createHold: database exclusion constraint", () => {
  test("translates exclusion_violation (23P01) into SlotTakenError and rolls back", async () => {
    const existing = await addBooking(
      w.db,
      w,
      local("2026-11-02T10:00"),
      local("2026-11-02T10:45"),
    );
    hidden.bookingId = existing.id; // the availability check no longer sees it

    await expect(createHold(w.db, holdInput(w), opts)).rejects.toBeInstanceOf(SlotTakenError);
    expect(await w.db.select().from(booking)).toHaveLength(1);
  });
});
