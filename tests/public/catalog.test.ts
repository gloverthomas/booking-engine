import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { booking, bookingService, business, location, service, serviceLocation } from "@/db/schema";
import { loadBookingContext, loadBusiness, loadCatalog } from "@/lib/public-api-catalog";
import type { Db } from "@/server/db-types";
import { createTestDb } from "../helpers/test-db";
import { createService, seedBasics } from "../helpers/factories";

type Seed = Awaited<ReturnType<typeof seedBasics>>;

describe("public catalog loaders (real Postgres via PGlite)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let seed: Seed;
  let southId: string;
  let cutId: string;
  let beardId: string;
  let bookingId: string;

  beforeAll(async () => {
    const test = await createTestDb();
    db = test.db as unknown as Db;
    close = () => test.client.close();
    seed = await seedBasics(db);

    await db
      .update(business)
      .set({
        name: "Ryan Kennedy Hairdressing",
        settings: { depositPct: 50, policyVersion: "3", policyText: "Be kind", maxAdvanceDays: 60 },
      })
      .where(eq(business.id, seed.biz.id));

    await db.update(location).set({
      addressLine: "302 Rathdowne Street",
      suburb: "Carlton North",
      state: "VIC",
      postcode: "3054",
      sortOrder: 1,
    });
    const [south] = await db
      .insert(location)
      .values({ businessId: seed.biz.id, name: "Southside", sortOrder: 2 })
      .returning();
    southId = south.id;
    await db
      .insert(location)
      .values({ businessId: seed.biz.id, name: "Closed", active: false, sortOrder: 3 });
    await db
      .insert(location)
      .values({ businessId: seed.biz.id, name: "No services", sortOrder: 4 });

    const cut = await createService(db, seed.biz.id, {
      name: "Maintenance Haircut",
      category: "Hair",
      sortOrder: 1,
      intakeQuestions: [{ id: "q1", label: "Length?", required: true }],
    });
    const beard = await createService(db, seed.biz.id, {
      name: "Beard Trim",
      durationMin: 15,
      priceCents: 3000,
      depositPct: 100,
      sortOrder: 2,
    });
    const vip = await createService(db, seed.biz.id, { name: "VIP cut", vipOnly: true });
    const inactive = await createService(db, seed.biz.id, { name: "Retired", active: false });
    cutId = cut.id;
    beardId = beard.id;

    await db.insert(serviceLocation).values([
      { serviceId: cut.id, locationId: seed.loc.id },
      { serviceId: beard.id, locationId: seed.loc.id },
      { serviceId: vip.id, locationId: seed.loc.id },
      { serviceId: inactive.id, locationId: seed.loc.id },
      { serviceId: cut.id, locationId: southId },
    ]);

    const [b] = await db
      .insert(booking)
      .values({
        staffId: seed.stylist.id,
        locationId: seed.loc.id,
        clientId: seed.cl.id,
        during: {
          start: new Date("2026-11-20T03:30:00Z"),
          end: new Date("2026-11-20T04:15:00Z"),
        },
      })
      .returning();
    bookingId = b.id;
    await db.insert(bookingService).values([
      {
        bookingId,
        serviceId: beard.id,
        name: "Beard Trim",
        durationMin: 15,
        priceCents: 3000,
        position: 1,
      },
      {
        bookingId,
        serviceId: cut.id,
        name: "Maintenance Haircut",
        durationMin: 45,
        priceCents: 9500,
        position: 0,
      },
      {
        bookingId,
        serviceId: null,
        name: "Deleted service",
        durationMin: 5,
        priceCents: 0,
        position: 2,
      },
    ]);
  });

  afterAll(async () => {
    await close();
  });

  it("loads the business with defaults applied to settings", async () => {
    const ctx = await loadBusiness(db);
    expect(ctx.timezone).toBe("Australia/Melbourne");
    expect(ctx.settings.policyVersion).toBe("3");
    expect(ctx.settings.cancelWindowHours).toBe(24);
  });

  it("lists active locations that have public services, with effective deposit percentages", async () => {
    const ctx = await loadBusiness(db);
    const catalog = await loadCatalog(db, ctx, new Date("2026-11-14T00:00:00Z"));

    expect(catalog.today).toBe("2026-11-14");
    expect(catalog.maxAdvanceDays).toBe(60);
    expect(catalog.policy).toMatchObject({ version: "3", text: "Be kind", cancelWindowHours: 24 });
    expect(catalog.locations.map((l) => l.name)).toEqual(["Northside", "Southside"]);

    const north = catalog.locations[0];
    expect(north.addressLine).toBe("302 Rathdowne Street");
    expect(north.services.map((s) => s.name)).toEqual(["Maintenance Haircut", "Beard Trim"]);
    expect(north.services[0]).toMatchObject({
      id: cutId,
      category: "Hair",
      depositPct: 50,
      intakeQuestions: [{ id: "q1", label: "Length?", required: true }],
    });
    expect(north.services[1]).toMatchObject({ id: beardId, depositPct: 100 });
    expect(catalog.locations[1].services).toHaveLength(1);
  });

  it("returns an empty list when nothing is bookable", async () => {
    const test = await createTestDb();
    const [biz] = await test.db.insert(business).values({ name: "Empty" }).returning();
    await test.db.insert(location).values({ businessId: biz.id, name: "Only" });
    await test.db
      .insert(service)
      .values({ businessId: biz.id, name: "x", durationMin: 5, priceCents: 1 });
    const ctx = await loadBusiness(test.db as unknown as Db);
    const catalog = await loadCatalog(test.db as unknown as Db, ctx, new Date());
    expect(catalog.locations).toEqual([]);
    await test.client.close();
  });

  it("fails clearly when no business exists", async () => {
    const test = await createTestDb();
    await expect(loadBusiness(test.db as unknown as Db)).rejects.toThrow(/No business configured/);
    await test.client.close();
  });

  it("loads a booking's location and services in position order", async () => {
    const ctx = await loadBookingContext(db, bookingId);
    expect(ctx).toEqual({
      locationId: seed.loc.id,
      locationName: "Northside",
      address: "302 Rathdowne Street, Carlton North VIC 3054",
      arrivalNote: null,
      serviceIds: [cutId, beardId],
    });
  });

  it("returns null for an unknown booking and null address for a bare location", async () => {
    expect(await loadBookingContext(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const [b2] = await db
      .insert(booking)
      .values({
        staffId: seed.stylist.id,
        locationId: southId,
        clientId: seed.cl.id,
        during: {
          start: new Date("2026-11-21T03:30:00Z"),
          end: new Date("2026-11-21T04:15:00Z"),
        },
      })
      .returning();
    expect((await loadBookingContext(db, b2.id))?.address).toBeNull();
  });
});
