import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyBookings, applyClients } from "@/server/import/apply";
import type { BookingOp, ClientOp, ClientValues } from "@/server/import/types";
import { createWorld, local, NOW, type World } from "../availability/setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

const values: ClientValues = {
  firstName: "Ana",
  lastName: "Ruiz",
  email: "ana@example.com",
  phone: null,
  notes: null,
  marketingOptIn: false,
  blocked: false,
  createdAt: null,
};

const bookingOp = (overrides: Partial<BookingOp> = {}): BookingOp => ({
  row: 2,
  action: "create",
  externalRef: "timely:1",
  client: { kind: "existing", id: w.clientId },
  staffId: w.staffId,
  locationId: w.locationId,
  start: local("2026-11-05T09:00"),
  end: local("2026-11-05T09:45"),
  status: "confirmed",
  totalCents: 9500,
  depositCents: 0,
  balanceCents: 0,
  lines: [{ serviceId: null, name: "Cut", durationMin: 45, priceCents: 9500 }],
  notes: null,
  ...overrides,
});

describe("applyClients failures", () => {
  test("linking to a client that has gone is reported, not thrown", async () => {
    const op: ClientOp = {
      row: 4,
      action: "link",
      externalRef: "timely:9",
      existingId: "00000000-0000-4000-8000-000000000000",
      values,
    };
    const result = await applyClients(w.db, [op]);
    expect(result).toMatchObject({ created: 0, linked: 0, failed: 1 });
    expect(result.issues).toEqual([
      expect.objectContaining({
        row: 4,
        level: "error",
        message: expect.stringContaining("disappeared"),
      }),
    ]);
  });

  test("a duplicate reference is reported as already imported", async () => {
    const op: ClientOp = { row: 2, action: "create", externalRef: "timely:5", values };
    await applyClients(w.db, [op]);
    const again = await applyClients(w.db, [{ ...op, row: 3 }]);
    expect(again.failed).toBe(1);
    expect(again.issues[0].message).toBe("Already imported");
  });
});

describe("applyBookings failures", () => {
  const opts = { sendReminders: false, now: NOW };

  test("applying the same plan twice reports already imported the second time", async () => {
    expect((await applyBookings(w.db, [bookingOp()], opts)).created).toBe(1);
    const again = await applyBookings(
      w.db,
      [bookingOp({ row: 3, start: local("2026-11-06T09:00"), end: local("2026-11-06T09:45") })],
      opts,
    );
    expect(again.failed).toBe(1);
    expect(again.issues[0].message).toBe("Already imported");
  });

  test("an overlap is reported in plain words", async () => {
    await applyBookings(w.db, [bookingOp()], opts);
    const clash = await applyBookings(
      w.db,
      [
        bookingOp({
          row: 3,
          externalRef: "timely:2",
          start: local("2026-11-05T09:15"),
          end: local("2026-11-05T10:00"),
        }),
      ],
      opts,
    );
    expect(clash.issues[0].message).toBe("Overlaps another booking for this stylist");
  });

  test("any other failure carries its own message", async () => {
    const bad = await applyBookings(
      w.db,
      [bookingOp({ staffId: "00000000-0000-4000-8000-000000000000" })],
      opts,
    );
    expect(bad).toMatchObject({ created: 0, failed: 1 });
    expect(bad.issues[0].level).toBe("error");
  });

  test("ops that are not creates are ignored", async () => {
    const result = await applyBookings(w.db, [bookingOp({ action: "unchanged" })], opts);
    expect(result).toMatchObject({ created: 0, failed: 0 });
  });
});
