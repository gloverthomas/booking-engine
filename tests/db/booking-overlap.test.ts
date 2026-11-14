import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { booking, staff } from "@/db/schema";
import { seedBasics } from "../helpers/factories";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

let t: TestDb;
let locationId: string;
let staffId: string;
let clientId: string;

const slot = (start: string, end: string) => ({
  start: new Date(start),
  end: new Date(end),
});

async function insertBooking(
  status: "pending_payment" | "confirmed" | "cancelled_by_client" | "expired",
  start: string,
  end: string,
  forStaff = staffId,
) {
  return t.db
    .insert(booking)
    .values({ staffId: forStaff, locationId, clientId, status, during: slot(start, end) })
    .returning();
}

beforeEach(async () => {
  t = await createTestDb();
  const seed = await seedBasics(t.db);
  locationId = seed.loc.id;
  staffId = seed.stylist.id;
  clientId = seed.cl.id;
});

afterEach(async () => {
  await t.client.close();
});

describe("booking overlap constraint (double-booking guard)", () => {
  test("stores and returns the booked time range", async () => {
    const [row] = await insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    expect(row.during.start.toISOString()).toBe("2026-11-21T03:30:00.000Z");
    expect(row.during.end.toISOString()).toBe("2026-11-21T04:15:00.000Z");
  });

  test("rejects an overlapping confirmed booking for the same staff member", async () => {
    await insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    await expect(
      insertBooking("confirmed", "2026-11-21T04:00:00Z", "2026-11-21T04:45:00Z"),
    ).rejects.toThrow();
  });

  test("a pending (held) booking also blocks the slot", async () => {
    await insertBooking("pending_payment", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    await expect(
      insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z"),
    ).rejects.toThrow();
  });

  test("allows back-to-back bookings (end of one equals start of next)", async () => {
    await insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    await expect(
      insertBooking("confirmed", "2026-11-21T04:15:00Z", "2026-11-21T05:00:00Z"),
    ).resolves.toHaveLength(1);
  });

  test("allows overlapping times for different staff members", async () => {
    const [other] = await t.db.insert(staff).values({ name: "Sam" }).returning({ id: staff.id });
    await insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    await expect(
      insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z", other.id),
    ).resolves.toHaveLength(1);
  });

  test("a cancelled booking frees the slot", async () => {
    await insertBooking("cancelled_by_client", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    await expect(
      insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z"),
    ).resolves.toHaveLength(1);
  });

  test("an expired hold frees the slot", async () => {
    await insertBooking("expired", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z");
    await expect(
      insertBooking("confirmed", "2026-11-21T03:30:00Z", "2026-11-21T04:15:00Z"),
    ).resolves.toHaveLength(1);
  });

  test("rejects a booking whose end is not after its start", async () => {
    await expect(
      insertBooking("confirmed", "2026-11-21T04:15:00Z", "2026-11-21T04:15:00Z"),
    ).rejects.toThrow();
  });
});
