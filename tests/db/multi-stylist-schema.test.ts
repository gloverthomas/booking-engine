import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  integrationAccount,
  rosterException,
  staffTarget,
  timeEntry,
  waitlistEntry,
  waitlistOffer,
} from "@/db/schema";
import { createTestDb } from "../helpers/test-db";
import { createStaff, seedBasics } from "../helpers/factories";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterEach(async () => {
  await t.client.close();
});

describe("roster_exception", () => {
  test("an off day needs no hours; a custom day needs a valid range", async () => {
    const base = { staffId: seed.stylist.id, date: "2026-12-25" };
    await expect(
      t.db.insert(rosterException).values({ ...base, kind: "off" }),
    ).resolves.toBeDefined();
    await expect(
      t.db
        .insert(rosterException)
        .values({ ...base, kind: "custom", startMinute: 600, endMinute: 900 }),
    ).resolves.toBeDefined();
    await expect(
      t.db.insert(rosterException).values({ ...base, kind: "custom" }),
    ).rejects.toThrow();
    await expect(
      t.db
        .insert(rosterException)
        .values({ ...base, kind: "custom", startMinute: 900, endMinute: 600 }),
    ).rejects.toThrow();
  });
});

describe("time_entry", () => {
  test("a person can have only one open entry, and clock-out must be after clock-in", async () => {
    const clockIn = new Date("2026-11-16T22:00:00Z");
    await t.db.insert(timeEntry).values({ staffId: seed.stylist.id, clockIn });
    await expect(
      t.db.insert(timeEntry).values({ staffId: seed.stylist.id, clockIn }),
    ).rejects.toThrow();

    const other = await createStaff(t.db, seed.biz.id);
    await expect(
      t.db.insert(timeEntry).values({ staffId: other.id, clockIn }),
    ).resolves.toBeDefined();
    await expect(
      t.db.insert(timeEntry).values({
        staffId: other.id,
        clockIn: new Date("2026-11-10T22:00:00Z"),
        clockOut: new Date("2026-11-10T21:00:00Z"),
      }),
    ).rejects.toThrow();
  });

  test("closed entries do not block a new open one", async () => {
    await t.db.insert(timeEntry).values({
      staffId: seed.stylist.id,
      clockIn: new Date("2026-11-10T22:00:00Z"),
      clockOut: new Date("2026-11-11T06:00:00Z"),
    });
    await expect(
      t.db
        .insert(timeEntry)
        .values({ staffId: seed.stylist.id, clockIn: new Date("2026-11-11T22:00:00Z") }),
    ).resolves.toBeDefined();
  });
});

describe("staff_target", () => {
  test("targets must be positive", async () => {
    const row = { metric: "revenue" as const, period: "week" as const, validFrom: "2026-11-01" };
    await expect(
      t.db.insert(staffTarget).values({ ...row, targetValue: 500000 }),
    ).resolves.toBeDefined();
    await expect(t.db.insert(staffTarget).values({ ...row, targetValue: 0 })).rejects.toThrow();
  });
});

describe("integration_account per person", () => {
  test("one business-wide account per provider, and one calendar per stylist", async () => {
    const biz = { businessId: seed.biz.id };
    await t.db.insert(integrationAccount).values({ ...biz, provider: "xero" });
    await expect(
      t.db.insert(integrationAccount).values({ ...biz, provider: "xero" }),
    ).rejects.toThrow();

    await t.db
      .insert(integrationAccount)
      .values({ ...biz, provider: "google", staffId: seed.stylist.id });
    const other = await createStaff(t.db, seed.biz.id);
    await expect(
      t.db.insert(integrationAccount).values({ ...biz, provider: "google", staffId: other.id }),
    ).resolves.toBeDefined();
    await expect(
      t.db
        .insert(integrationAccount)
        .values({ ...biz, provider: "google", staffId: seed.stylist.id }),
    ).rejects.toThrow();
  });
});

describe("waitlist", () => {
  test("an entry and an offer round-trip, and an empty offer range is refused", async () => {
    const [entry] = await t.db
      .insert(waitlistEntry)
      .values({
        clientId: seed.cl.id,
        locationId: seed.loc.id,
        serviceIds: ["svc"],
        earliestDate: "2026-11-20",
        latestDate: "2026-11-30",
        expiresAt: new Date("2026-11-30T13:00:00Z"),
      })
      .returning();
    expect(entry.status).toBe("waiting");

    const during = {
      start: new Date("2026-11-21T03:30:00Z"),
      end: new Date("2026-11-21T04:15:00Z"),
    };
    const [offer] = await t.db
      .insert(waitlistOffer)
      .values({
        entryId: entry.id,
        staffId: seed.stylist.id,
        locationId: seed.loc.id,
        during,
        expiresAt: new Date("2026-11-20T00:20:00Z"),
      })
      .returning();
    expect(offer.during.start.toISOString()).toBe("2026-11-21T03:30:00.000Z");
    expect(offer.status).toBe("sent");

    await expect(
      t.db.insert(waitlistOffer).values({
        entryId: entry.id,
        staffId: seed.stylist.id,
        locationId: seed.loc.id,
        during: { start: during.start, end: during.start },
        expiresAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe("staff migration", () => {
  test("new staff default to the stylist role", async () => {
    const s = await createStaff(t.db, seed.biz.id, { role: undefined });
    expect(s.role).toBe("stylist");
    expect(seed.stylist.role).toBe("owner");
  });
});
