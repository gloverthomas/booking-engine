import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  availabilityRule,
  booking,
  bookingService,
  business,
  location,
  serviceLevelPrice,
  serviceLocation,
  serviceStaff,
  staff,
} from "@/db/schema";
import { loadBookingContext, loadBusiness, loadCatalog } from "@/lib/public-api-catalog";
import type { Db } from "@/server/db-types";
import { createService, createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-11-14T00:00:00Z");

describe("catalog with stylists (real Postgres via PGlite)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let seed: Awaited<ReturnType<typeof seedBasics>>;
  let southId: string;
  let cutId: string;
  let beardId: string;
  let bea: typeof staff.$inferSelect;
  let cy: typeof staff.$inferSelect;
  let dee: typeof staff.$inferSelect;
  let gone: typeof staff.$inferSelect;
  let bookingId: string;

  const rule = (staffId: string, locationId: string, extra = {}) => ({
    staffId,
    locationId,
    weekday: 2,
    startMinute: 540,
    endMinute: 1020,
    ...extra,
  });

  beforeAll(async () => {
    const test = await createTestDb();
    db = test.db as unknown as Db;
    close = () => test.client.close();
    seed = await seedBasics(db);

    await db
      .update(business)
      .set({ settings: { chooseStaff: true, waitlistEnabled: true } })
      .where(eq(business.id, seed.biz.id));

    const [south] = await db
      .insert(location)
      .values({ businessId: seed.biz.id, name: "Southside", sortOrder: 2 })
      .returning();
    southId = south.id;

    const cut = await createService(db, seed.biz.id, { name: "Cut", sortOrder: 1 });
    const beard = await createService(db, seed.biz.id, {
      name: "Beard",
      durationMin: 15,
      priceCents: 3000,
      sortOrder: 2,
    });
    cutId = cut.id;
    beardId = beard.id;
    await db.insert(serviceLocation).values([
      { serviceId: cut.id, locationId: seed.loc.id },
      { serviceId: beard.id, locationId: seed.loc.id },
      { serviceId: cut.id, locationId: southId },
    ]);

    // Ryan (level 0) is the owner; Bea is level 1, Cy has his own price, Dee never works at Northside.
    bea = await createStaff(db, seed.biz.id, { name: "Bea", email: "b@x.com", level: 1 });
    cy = await createStaff(db, seed.biz.id, { name: "Cy", email: "c@x.com", level: 1 });
    dee = await createStaff(db, seed.biz.id, { name: "Dee", email: "d@x.com", level: 0 });
    gone = await createStaff(db, seed.biz.id, {
      name: "Gone",
      email: "g@x.com",
      active: false,
    });

    await db.insert(serviceStaff).values([
      { serviceId: cut.id, staffId: seed.stylist.id },
      { serviceId: beard.id, staffId: seed.stylist.id },
      { serviceId: cut.id, staffId: bea.id },
      { serviceId: cut.id, staffId: cy.id, priceCents: 8800, durationMin: null },
      { serviceId: beard.id, staffId: cy.id },
      { serviceId: cut.id, staffId: dee.id },
      { serviceId: cut.id, staffId: gone.id },
    ]);
    await db
      .insert(serviceLevelPrice)
      .values([{ serviceId: cut.id, level: 1, priceCents: 7500, durationMin: 60 }]);
    await db
      .insert(availabilityRule)
      .values([
        rule(seed.stylist.id, seed.loc.id),
        rule(seed.stylist.id, southId),
        rule(bea.id, seed.loc.id),
        rule(cy.id, seed.loc.id),
        rule(dee.id, southId),
        rule(gone.id, seed.loc.id),
      ]);

    const [b] = await db
      .insert(booking)
      .values({
        staffId: bea.id,
        locationId: seed.loc.id,
        clientId: seed.cl.id,
        staffRequested: true,
        during: {
          start: new Date("2026-11-20T03:30:00Z"),
          end: new Date("2026-11-20T04:15:00Z"),
        },
      })
      .returning();
    bookingId = b.id;
    await db.insert(bookingService).values({
      bookingId,
      serviceId: cut.id,
      name: "Cut",
      durationMin: 60,
      priceCents: 7500,
      position: 0,
    });
  });

  afterAll(async () => {
    await close();
  });

  it("lists, per location, the active stylists who work there and offer something", async () => {
    const catalog = await loadCatalog(db, await loadBusiness(db), NOW);
    const north = catalog.locations.find((l) => l.id === seed.loc.id);
    const south = catalog.locations.find((l) => l.id === southId);
    expect(north?.staff.map((s) => s.name)).toEqual(["Bea", "Cy", "Ryan"]);
    expect(south?.staff.map((s) => s.name)).toEqual(["Dee", "Ryan"]);
  });

  it("resolves each price through priceFor: own override, then level, then the service", async () => {
    const catalog = await loadCatalog(db, await loadBusiness(db), NOW);
    const north = catalog.locations.find((l) => l.id === seed.loc.id);
    const byName = Object.fromEntries((north?.staff ?? []).map((s) => [s.name, s]));
    expect(byName.Ryan.offers).toEqual({
      [cutId]: { priceCents: 9500, durationMin: 45 },
      [beardId]: { priceCents: 3000, durationMin: 15 },
    });
    expect(byName.Bea.offers).toEqual({ [cutId]: { priceCents: 7500, durationMin: 60 } });
    // Cy: own price beats the level price; the level's duration still applies.
    expect(byName.Cy.offers[cutId]).toEqual({ priceCents: 8800, durationMin: 60 });
    expect(byName.Cy.offers[beardId]).toEqual({ priceCents: 3000, durationMin: 15 });
  });

  it("only lists services offered at that location", async () => {
    const catalog = await loadCatalog(db, await loadBusiness(db), NOW);
    const south = catalog.locations.find((l) => l.id === southId);
    const ryan = south?.staff.find((s) => s.name === "Ryan");
    expect(Object.keys(ryan?.offers ?? {})).toEqual([cutId]);
  });

  it("leaves out stylists whose weekly hours at the location have all ended", async () => {
    await db.insert(availabilityRule).values(rule(dee.id, seed.loc.id, { validTo: "2026-11-01" }));
    const catalog = await loadCatalog(db, await loadBusiness(db), NOW);
    expect(catalog.locations.find((l) => l.id === seed.loc.id)?.staff.map((s) => s.name)).toEqual([
      "Bea",
      "Cy",
      "Ryan",
    ]);
  });

  it("exposes the settings and no stylists when choosing is off", async () => {
    await db
      .update(business)
      .set({ settings: { chooseStaff: false, waitlistEnabled: false } })
      .where(eq(business.id, seed.biz.id));
    const catalog = await loadCatalog(db, await loadBusiness(db), NOW);
    expect(catalog.chooseStaff).toBe(false);
    expect(catalog.waitlistEnabled).toBe(false);
    expect(catalog.locations.every((l) => l.staff.length === 0)).toBe(true);

    await db
      .update(business)
      .set({ settings: { chooseStaff: true } })
      .where(eq(business.id, seed.biz.id));
    const on = await loadCatalog(db, await loadBusiness(db), NOW);
    expect(on.chooseStaff).toBe(true);
    expect(on.waitlistEnabled).toBe(true);
  });

  it("says who a booking is with, and whether the client asked for them", async () => {
    const ctx = await loadBookingContext(db, bookingId);
    expect(ctx).toMatchObject({
      staffId: bea.id,
      staffName: "Bea",
      staffRequested: true,
    });
  });
});
