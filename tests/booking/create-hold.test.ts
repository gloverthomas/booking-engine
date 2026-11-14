import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { booking, bookingService, client, service, staff } from "@/db/schema";
import {
  ClientBlockedError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
  VipOnlyError,
  createHold,
} from "@/server/booking";
import { findOrCreateClient } from "@/server/clients";
import { verifyManageToken } from "@/server/manage-token";
import { createService } from "../helpers/factories";
import {
  NOW,
  addBooking,
  addStaff,
  createWorld,
  local,
  offer,
  openEveryDay,
  setSettings,
  type World,
} from "../availability/setup";
import { CLIENT, KEY, auditActions, bookingRow, hold, holdInput, opts } from "./setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

describe("createHold: success", () => {
  test("creates a pending_payment booking that holds the slot for holdMinutes", async () => {
    const result = await hold(w);

    expect(result.holdExpiresAt.toISOString()).toBe(
      new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    );
    expect(result.totalCents).toBe(9500);
    expect(result.depositCents).toBe(4750);
    expect(result.during.start).toEqual(local("2026-11-02T10:00"));
    expect(result.during.end).toEqual(local("2026-11-02T10:45"));

    const row = await bookingRow(w.db, result.bookingId);
    expect(row).toMatchObject({
      status: "pending_payment",
      staffId: w.staffId,
      locationId: w.locationId,
      totalCents: 9500,
      depositCents: 4750,
      source: "online",
      policyVersion: "1",
      bookedForOther: false,
    });
    expect(row.holdExpiresAt).toEqual(result.holdExpiresAt);
    expect(row.policyAcceptedAt).toEqual(NOW);
    expect(row.during).toEqual({
      start: local("2026-11-02T10:00"),
      end: local("2026-11-02T10:45"),
    });
  });

  test("returns a stateless manage token for the booking", async () => {
    const result = await hold(w);
    expect(verifyManageToken(result.manageToken, KEY)).toBe(result.bookingId);
  });

  test("snapshots each service (name, duration, price) in order", async () => {
    const colour = await createService(w.db, w.businessId, {
      name: "Colour",
      durationMin: 60,
      priceCents: 15000,
    });
    await offer(w.db, colour.id, w.locationId, w.staffId, { priceCents: 16000, durationMin: 70 });
    const result = await hold(w, { serviceIds: [w.haircutId, colour.id] });

    const rows = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, result.bookingId))
      .orderBy(bookingService.position);
    expect(rows.map((r) => [r.name, r.durationMin, r.priceCents, r.position])).toEqual([
      ["Maintenance Haircut", 45, 9500, 0],
      ["Colour", 70, 16000, 1], // per-staff overrides are what the client was quoted
    ]);
    expect(result.totalCents).toBe(25500);
    expect(result.during.end).toEqual(local("2026-11-02T11:55"));
  });

  test("later price edits do not rewrite the snapshot", async () => {
    const result = await hold(w);
    await w.db.update(service).set({ priceCents: 20000 }).where(eq(service.id, w.haircutId));
    const [line] = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, result.bookingId));
    expect(line.priceCents).toBe(9500);
  });

  test("deposit uses the per-service override, falling back to the business percentage", async () => {
    const colour = await createService(w.db, w.businessId, {
      name: "Colour",
      durationMin: 60,
      priceCents: 20000,
      depositPct: 25,
    });
    await offer(w.db, colour.id, w.locationId, w.staffId);
    const result = await hold(w, { serviceIds: [w.haircutId, colour.id] });
    // 50% of 9500 + 25% of 20000
    expect(result.depositCents).toBe(4750 + 5000);
  });

  test("a 0% deposit yields a zero deposit", async () => {
    await setSettings(w.db, w.businessId, { depositPct: 0 });
    expect((await hold(w)).depositCents).toBe(0);
  });

  test("the booking occupies the stylist for the appointment plus the last buffer", async () => {
    await w.db.update(service).set({ bufferMin: 15 }).where(eq(service.id, w.haircutId));
    const result = await hold(w);
    const row = await bookingRow(w.db, result.bookingId);
    expect(row.during.end).toEqual(local("2026-11-02T11:00")); // 45 + 15
    expect(result.during.end).toEqual(local("2026-11-02T10:45")); // the client sees 45
    // the buffer is genuinely unavailable to the next client
    await expect(
      hold(w, {
        start: local("2026-11-02T10:45"),
        client: { ...CLIENT, email: "b@example.com", phone: "0433 111 222" },
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  test("stores optional details", async () => {
    const result = await hold(w, {
      bookedForOther: true,
      comments: "Running 5 min late",
      intakeAnswers: { q1: "none" },
      source: "admin",
    });
    const row = await bookingRow(w.db, result.bookingId);
    expect(row).toMatchObject({
      bookedForOther: true,
      comments: "Running 5 min late",
      intakeAnswers: { q1: "none" },
      source: "admin",
    });
  });

  test("creates or matches the client and records an audit row", async () => {
    const first = await hold(w);
    const second = await hold(w, { start: local("2026-11-02T14:00") });
    const a = await bookingRow(w.db, first.bookingId);
    const b = await bookingRow(w.db, second.bookingId);
    expect(a.clientId).toBe(b.clientId);
    const [c] = await w.db.select().from(client).where(eq(client.id, a.clientId));
    expect(c).toMatchObject({ email: "alex@example.com", phone: "+61412345678" });
    expect(await auditActions(w.db, first.bookingId)).toEqual(["booking.hold"]);
  });
});

describe("createHold: staff assignment", () => {
  test("with no staffId, assigns whoever is free at that time", async () => {
    const zed = await addStaff(w.db, w.businessId, "Zed");
    await offer(w.db, w.haircutId, w.locationId, zed.id);
    await openEveryDay(w.db, zed.id, w.locationId);
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45")); // Ryan busy

    const result = await hold(w, { staffId: undefined });
    expect((await bookingRow(w.db, result.bookingId)).staffId).toBe(zed.id);
  });

  test("with no staffId and nobody free, the slot is taken", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    await expect(hold(w, { staffId: undefined })).rejects.toBeInstanceOf(SlotTakenError);
  });

  test("an inactive stylist cannot be booked", async () => {
    await w.db.update(staff).set({ active: false }).where(eq(staff.id, w.staffId));
    await expect(hold(w)).rejects.toBeInstanceOf(SlotTakenError);
  });
});

describe("createHold: slot validation", () => {
  test("rejects a slot that is already held, and a lapsed hold frees it", async () => {
    await hold(w);
    const other = { ...CLIENT, email: "b@example.com", phone: "0433 111 222" };
    await expect(hold(w, { client: other })).rejects.toBeInstanceOf(SlotTakenError);

    // 11 minutes later the first hold has lapsed (holdMinutes = 10) although nobody swept it
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const retry = await hold(w, { client: other, now: later });
    expect((await bookingRow(w.db, retry.bookingId)).status).toBe("pending_payment");
    const rows = await w.db.select().from(booking);
    expect(rows.map((r) => r.status).sort()).toEqual(["expired", "pending_payment"]);
  });

  test("rejects times that are off the grid, outside hours, too soon or too far ahead", async () => {
    const offGrid = local("2026-11-02T10:05");
    const outsideHours = local("2026-11-02T08:00");
    const tooSoon = local("2026-11-01T09:00"); // within the 120 minute notice from NOW (08:00)
    const tooFar = local("2027-03-01T10:00");
    for (const start of [offGrid, outsideHours, tooSoon, tooFar]) {
      await expect(hold(w, { start })).rejects.toBeInstanceOf(SlotTakenError);
    }
  });

  test("rejects a start that would overlap an existing confirmed booking", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:30"), local("2026-11-02T11:15"));
    await expect(hold(w, { start: local("2026-11-02T10:00") })).rejects.toBeInstanceOf(
      SlotTakenError,
    );
  });

  test("a failed attempt leaves nothing behind (not even the client)", async () => {
    await expect(hold(w, { start: local("2026-11-02T08:00") })).rejects.toBeInstanceOf(
      SlotTakenError,
    );
    expect(
      await w.db.select().from(client).where(eq(client.email, "alex@example.com")),
    ).toHaveLength(0);
    expect(await w.db.select().from(booking)).toHaveLength(0);
  });
});

describe("createHold: guards", () => {
  test("rejects a stale policy version", async () => {
    await setSettings(w.db, w.businessId, { policyVersion: "2" });
    await expect(hold(w, { policyVersion: "1" })).rejects.toBeInstanceOf(PolicyVersionError);
    await expect(hold(w, { policyVersion: "2" })).resolves.toBeTruthy();
  });

  test("refuses blocked clients", async () => {
    const created = await hold(w);
    const row = await bookingRow(w.db, created.bookingId);
    await w.db.update(client).set({ blocked: true }).where(eq(client.id, row.clientId));
    await expect(hold(w, { start: local("2026-11-02T14:00") })).rejects.toBeInstanceOf(
      ClientBlockedError,
    );
  });

  test("vip-only services need a VIP client", async () => {
    const vip = await createService(w.db, w.businessId, { name: "Private Session", vipOnly: true });
    await offer(w.db, vip.id, w.locationId, w.staffId);

    const existing = await findOrCreateClient(w.db, CLIENT, w.businessId);
    await expect(hold(w, { serviceIds: [vip.id] })).rejects.toBeInstanceOf(VipOnlyError);

    await w.db.update(client).set({ isVip: true }).where(eq(client.id, existing.id));
    await expect(hold(w, { serviceIds: [vip.id] })).resolves.toBeTruthy();
  });

  test("rejects unknown, inactive and not-offered services with a ValidationError", async () => {
    await expect(
      hold(w, { serviceIds: ["00000000-0000-4000-8000-000000000000"] }),
    ).rejects.toBeInstanceOf(ValidationError);

    await w.db.update(service).set({ active: false }).where(eq(service.id, w.haircutId));
    await expect(hold(w)).rejects.toBeInstanceOf(ValidationError);

    const elsewhere = await createService(w.db, w.businessId, { name: "Elsewhere" });
    await expect(hold(w, { serviceIds: [elsewhere.id] })).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects malformed input and bad client details", async () => {
    await expect(hold(w, { serviceIds: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(hold(w, { locationId: "nope" })).rejects.toBeInstanceOf(ValidationError);
    await expect(hold(w, { start: new Date("garbage") })).rejects.toBeInstanceOf(ValidationError);
    await expect(hold(w, { policyVersion: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(hold(w, { client: { ...CLIENT, phone: "12345" } })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await w.db.select().from(booking)).toHaveLength(0);
  });

  test("an unknown location is a not-found error", async () => {
    await expect(
      createHold(w.db, holdInput(w, { locationId: "00000000-0000-4000-8000-000000000000" }), opts),
    ).rejects.toThrow(/Location not found/);
  });
});
