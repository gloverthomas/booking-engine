import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db";
import { seedBasics } from "../helpers/factories";
import { auditLog, booking, bookingService, location, service, serviceStaff } from "@/db/schema";
import { serviceLocation } from "@/db/schema";
import {
  deleteLocation,
  deleteService,
  getService,
  listLocations,
  listServices,
  saveLocation,
  saveService,
} from "@/server/admin-foundation/catalog";
import {
  locationInputSchema,
  serviceInputSchema,
  type ServiceFormInput,
} from "@/server/admin-foundation/catalog-schemas";
import { isAdminError } from "@/server/admin-foundation/errors";
import type { Actor } from "@/server/audit";

const actor: Actor = "owner:user-1";

type Harness = Awaited<ReturnType<typeof createTestDb>>;

describe("service and location catalog", () => {
  let h: Harness;
  let fx: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    h = await createTestDb();
    fx = await seedBasics(h.db);
  });
  afterEach(async () => {
    await h.client.close();
  });

  function formInput(overrides: Partial<ServiceFormInput> = {}): ServiceFormInput {
    return {
      name: "Maintenance Haircut",
      durationMin: 45,
      price: "95",
      locationIds: [fx.loc.id],
      staff: [{ staffId: fx.stylist.id }],
      ...overrides,
    };
  }

  describe("validation", () => {
    test("turns dollars into cents and applies defaults", () => {
      const parsed = serviceInputSchema.parse(formInput({ price: "$126.50" }));
      expect(parsed).toMatchObject({
        priceCents: 12650,
        bufferMin: 0,
        depositPct: null,
        vipOnly: false,
        active: true,
        intakeQuestions: [],
      });
    });

    test("rejects bad prices, durations and duplicate intake ids", () => {
      expect(serviceInputSchema.safeParse(formInput({ price: "ninety" })).success).toBe(false);
      expect(serviceInputSchema.safeParse(formInput({ price: "-5" })).success).toBe(false);
      expect(serviceInputSchema.safeParse(formInput({ durationMin: 2 })).success).toBe(false);
      expect(serviceInputSchema.safeParse(formInput({ depositPct: 120 })).success).toBe(false);
      const dup = serviceInputSchema.safeParse(
        formInput({
          intakeQuestions: [
            { id: "allergies", label: "Allergies?", required: true },
            { id: "allergies", label: "Again?", required: false },
          ],
        }),
      );
      expect(dup.success).toBe(false);
      const badId = serviceInputSchema.safeParse(
        formInput({ intakeQuestions: [{ id: "Bad Id!", label: "x", required: false }] }),
      );
      expect(badId.success).toBe(false);
    });

    test("rejects the same stylist listed twice and blank names", () => {
      const twice = serviceInputSchema.safeParse(
        formInput({ staff: [{ staffId: fx.stylist.id }, { staffId: fx.stylist.id }] }),
      );
      expect(twice.success).toBe(false);
      expect(serviceInputSchema.safeParse(formInput({ name: "   " })).success).toBe(false);
    });

    test("location input blanks become null", () => {
      const parsed = locationInputSchema.parse({ name: " Prahran ", suburb: "", phone: null });
      expect(parsed).toMatchObject({ name: "Prahran", suburb: null, phone: null, active: true });
    });
  });

  describe("services", () => {
    test("creates a service with offerings, storing cents, and audits it", async () => {
      const second = await saveLocation(
        h.db,
        actor,
        locationInputSchema.parse({ name: "South side" }),
      );
      const { id } = await saveService(
        h.db,
        actor,
        serviceInputSchema.parse(
          formInput({
            price: "95",
            bufferMin: 5,
            depositPct: 30,
            vipOnly: true,
            category: "Cuts",
            description: "Neat tidy",
            intakeQuestions: [{ id: "allergies", label: "Any allergies?", required: true }],
            locationIds: [fx.loc.id, second.id],
            staff: [{ staffId: fx.stylist.id, price: "100.50", durationMin: 50 }],
          }),
        ),
      );

      const [row] = await h.db.select().from(service).where(eq(service.id, id));
      expect(row).toMatchObject({
        name: "Maintenance Haircut",
        priceCents: 9500,
        durationMin: 45,
        bufferMin: 5,
        depositPct: 30,
        vipOnly: true,
        category: "Cuts",
        businessId: fx.biz.id,
      });
      expect(row?.intakeQuestions).toEqual([
        { id: "allergies", label: "Any allergies?", required: true },
      ]);
      expect(await h.db.select().from(serviceLocation)).toHaveLength(2);
      const [offer] = await h.db.select().from(serviceStaff);
      expect(offer).toMatchObject({ priceCents: 10050, durationMin: 50 });

      const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(entry).toMatchObject({
        actor: "owner:user-1",
        action: "service.created",
        entityType: "service",
      });
    });

    test("updates in place, replacing offerings and auditing the change", async () => {
      const { id } = await saveService(h.db, actor, serviceInputSchema.parse(formInput()));
      await saveService(
        h.db,
        actor,
        serviceInputSchema.parse(
          formInput({
            id,
            name: "Maintenance Cut",
            price: "99",
            active: false,
            locationIds: [],
            staff: [],
          }),
        ),
      );
      const detail = await getService(h.db, id);
      expect(detail).toMatchObject({
        name: "Maintenance Cut",
        priceCents: 9900,
        active: false,
        locationIds: [],
        staff: [],
      });
      const entries = await h.db.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(entries.map((e) => e.action).sort()).toEqual(["service.created", "service.updated"]);
    });

    test("lists services in sort order with their offerings", async () => {
      await saveService(
        h.db,
        actor,
        serviceInputSchema.parse(formInput({ name: "B service", sortOrder: 2 })),
      );
      await saveService(
        h.db,
        actor,
        serviceInputSchema.parse(
          formInput({
            name: "A service",
            sortOrder: 1,
            staff: [{ staffId: fx.stylist.id, price: "10", durationMin: 15 }],
          }),
        ),
      );
      const list = await listServices(h.db);
      expect(list.map((s) => s.name)).toEqual(["A service", "B service"]);
      expect(list[0]?.locationIds).toEqual([fx.loc.id]);
      expect(list[0]?.staff).toEqual([
        { staffId: fx.stylist.id, priceCents: 1000, durationMin: 15 },
      ]);
    });

    test("getService returns null for an unknown id", async () => {
      expect(await getService(h.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    test("refuses locations or stylists that do not exist, with a readable error", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      const badLoc = saveService(
        h.db,
        actor,
        serviceInputSchema.parse(formInput({ locationIds: [missing] })),
      );
      await expect(badLoc).rejects.toSatisfy(isAdminError);
      const badStaff = saveService(
        h.db,
        actor,
        serviceInputSchema.parse(formInput({ staff: [{ staffId: missing }] })),
      );
      await expect(badStaff).rejects.toThrow(/stylist/i);
      expect(await h.db.select().from(service)).toHaveLength(0);
    });

    test("refuses to update a service that does not exist", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      await expect(
        saveService(h.db, actor, serviceInputSchema.parse(formInput({ id: missing }))),
      ).rejects.toThrow(/not found/i);
    });

    test("deletes an unused service and audits it", async () => {
      const { id } = await saveService(h.db, actor, serviceInputSchema.parse(formInput()));
      await deleteService(h.db, actor, id);
      expect(await h.db.select().from(service)).toHaveLength(0);
      expect(await h.db.select().from(serviceLocation)).toHaveLength(0);
      const entries = await h.db.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(entries.map((e) => e.action)).toContain("service.deleted");
    });

    test("will not delete a service that is on a booking; says to deactivate it instead", async () => {
      const { id } = await saveService(h.db, actor, serviceInputSchema.parse(formInput()));
      const [b] = await h.db
        .insert(booking)
        .values({
          staffId: fx.stylist.id,
          locationId: fx.loc.id,
          clientId: fx.cl.id,
          during: {
            start: new Date("2030-01-01T00:00:00Z"),
            end: new Date("2030-01-01T01:00:00Z"),
          },
        })
        .returning();
      await h.db.insert(bookingService).values({
        bookingId: b!.id,
        serviceId: id,
        name: "Maintenance Haircut",
        durationMin: 45,
        priceCents: 9500,
      });
      await expect(deleteService(h.db, actor, id)).rejects.toThrow(/deactivate/i);
      expect(await h.db.select().from(service)).toHaveLength(1);
    });
  });

  describe("locations", () => {
    test("creates, updates and lists locations in order", async () => {
      const a = await saveLocation(
        h.db,
        actor,
        locationInputSchema.parse({
          name: "Prahran",
          addressLine: "249 High Street",
          suburb: "Prahran",
          state: "VIC",
          postcode: "3181",
          arrivalNote: "Ring the bell",
          sortOrder: 5,
        }),
      );
      await saveLocation(
        h.db,
        actor,
        locationInputSchema.parse({ id: a.id, name: "South side", active: false, sortOrder: 5 }),
      );
      const all = await listLocations(h.db);
      expect(all.map((l) => l.name)).toEqual(["Northside", "South side"]);
      expect(all[1]).toMatchObject({ active: false, addressLine: null, businessId: fx.biz.id });
      const entries = await h.db.select().from(auditLog).where(eq(auditLog.entityId, a.id));
      expect(entries.map((e) => e.action).sort()).toEqual(["location.created", "location.updated"]);
    });

    test("refuses to update a location that does not exist", async () => {
      await expect(
        saveLocation(
          h.db,
          actor,
          locationInputSchema.parse({ id: "00000000-0000-0000-0000-000000000000", name: "x" }),
        ),
      ).rejects.toThrow(/not found/i);
    });

    test("deletes an unused location but protects one with bookings", async () => {
      const unused = await saveLocation(h.db, actor, locationInputSchema.parse({ name: "Spare" }));
      await deleteLocation(h.db, actor, unused.id);
      expect((await h.db.select().from(location)).map((l) => l.id)).not.toContain(unused.id);

      await h.db.insert(booking).values({
        staffId: fx.stylist.id,
        locationId: fx.loc.id,
        clientId: fx.cl.id,
        during: { start: new Date("2030-01-01T00:00:00Z"), end: new Date("2030-01-01T01:00:00Z") },
      });
      await expect(deleteLocation(h.db, actor, fx.loc.id)).rejects.toThrow(/deactivate/i);
    });
  });
});
