import { asc, count, eq, inArray } from "drizzle-orm";
import {
  booking,
  bookingService,
  location,
  service,
  serviceLevelPrice,
  serviceLocation,
  serviceStaff,
  staff,
} from "@/db/schema";
import { recordAudit, type Actor } from "@/server/audit";
import type { Db } from "@/server/db-types";
import { getBusiness } from "./business";
import type { LocationInput, ServiceInput } from "./catalog-schemas";
import { AdminError } from "./errors";

export type ServiceRow = typeof service.$inferSelect;
export type LocationRow = typeof location.$inferSelect;
export type StaffRow = typeof staff.$inferSelect;

export interface StaffOffering {
  staffId: string;
  priceCents: number | null;
  durationMin: number | null;
}

export interface LevelPriceRow {
  level: number;
  priceCents: number | null;
  durationMin: number | null;
}

export interface ServiceDetail extends ServiceRow {
  locationIds: string[];
  staff: StaffOffering[];
  /** Seniority prices, lowest level first. */
  levelPrices: LevelPriceRow[];
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listStaff(db: Db): Promise<StaffRow[]> {
  return db.select().from(staff).orderBy(asc(staff.name));
}

export async function listLocations(db: Db): Promise<LocationRow[]> {
  return db.select().from(location).orderBy(asc(location.sortOrder), asc(location.name));
}

export async function getLocation(db: Db, id: string): Promise<LocationRow | null> {
  const [row] = await db.select().from(location).where(eq(location.id, id));
  return row ?? null;
}

export async function listServices(db: Db): Promise<ServiceDetail[]> {
  const [services, links, offerings, levels] = await Promise.all([
    db.select().from(service).orderBy(asc(service.sortOrder), asc(service.name)),
    db.select().from(serviceLocation),
    db.select().from(serviceStaff),
    db.select().from(serviceLevelPrice).orderBy(asc(serviceLevelPrice.level)),
  ]);
  return services.map((row) => ({
    ...row,
    locationIds: links.filter((l) => l.serviceId === row.id).map((l) => l.locationId),
    staff: offerings
      .filter((o) => o.serviceId === row.id)
      .map((o) => ({ staffId: o.staffId, priceCents: o.priceCents, durationMin: o.durationMin })),
    levelPrices: levels
      .filter((l) => l.serviceId === row.id)
      .map((l) => ({ level: l.level, priceCents: l.priceCents, durationMin: l.durationMin })),
  }));
}

export async function getService(db: Db, id: string): Promise<ServiceDetail | null> {
  const all = await listServices(db);
  return all.find((s) => s.id === id) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Services                                                                   */
/* -------------------------------------------------------------------------- */

async function assertExist(
  db: Db,
  table: typeof location | typeof staff,
  ids: readonly string[],
  message: string,
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const rows = await db.select({ id: table.id }).from(table).where(inArray(table.id, unique));
  if (rows.length !== unique.length) throw new AdminError("not_found", message);
}

export async function saveService(
  db: Db,
  actor: Actor,
  input: ServiceInput,
): Promise<{ id: string }> {
  const biz = await getBusiness(db);
  await assertExist(
    db,
    location,
    input.locationIds,
    "One of the selected locations no longer exists.",
  );
  await assertExist(
    db,
    staff,
    input.staff.map((s) => s.staffId),
    "One of the selected stylists no longer exists.",
  );

  const values = {
    name: input.name,
    description: input.description,
    category: input.category,
    durationMin: input.durationMin,
    priceCents: input.priceCents,
    bufferMin: input.bufferMin,
    depositPct: input.depositPct,
    vipOnly: input.vipOnly,
    intakeQuestions: input.intakeQuestions,
    active: input.active,
    sortOrder: input.sortOrder,
  };

  return db.transaction(async (tx) => {
    let id = input.id;
    if (id) {
      const updated = await tx.update(service).set(values).where(eq(service.id, id)).returning({
        id: service.id,
      });
      if (updated.length === 0) throw new AdminError("not_found", "Service not found.");
    } else {
      const [created] = await tx
        .insert(service)
        .values({ ...values, businessId: biz.id })
        .returning({ id: service.id });
      id = created?.id;
      if (!id) throw new Error("Insert returned no row");
    }

    await tx.delete(serviceLocation).where(eq(serviceLocation.serviceId, id));
    if (input.locationIds.length > 0) {
      await tx
        .insert(serviceLocation)
        .values(
          [...new Set(input.locationIds)].map((locationId) => ({ serviceId: id, locationId })),
        );
    }
    await tx.delete(serviceStaff).where(eq(serviceStaff.serviceId, id));
    if (input.staff.length > 0) {
      await tx.insert(serviceStaff).values(
        input.staff.map((s) => ({
          serviceId: id,
          staffId: s.staffId,
          priceCents: s.priceCents,
          durationMin: s.durationMin,
        })),
      );
    }

    // Only the filled-in rows are stored; a blank row means "inherit the service price".
    const levelRows = (input.levelPrices ?? []).filter(
      (row) => row.priceCents !== null || row.durationMin !== null,
    );
    if (input.levelPrices !== undefined) {
      await tx.delete(serviceLevelPrice).where(eq(serviceLevelPrice.serviceId, id));
      if (levelRows.length > 0) {
        await tx.insert(serviceLevelPrice).values(
          levelRows.map((row) => ({
            serviceId: id,
            level: row.level,
            priceCents: row.priceCents,
            durationMin: row.durationMin,
          })),
        );
      }
    }

    await recordAudit(tx, {
      actor,
      action: input.id ? "service.updated" : "service.created",
      entityType: "service",
      entityId: id,
      data: {
        name: input.name,
        priceCents: input.priceCents,
        active: input.active,
        ...(input.levelPrices !== undefined ? { levelRows: levelRows.length } : {}),
      },
    });
    return { id };
  });
}

export async function deleteService(db: Db, actor: Actor, id: string): Promise<void> {
  const [usage] = await db
    .select({ n: count() })
    .from(bookingService)
    .where(eq(bookingService.serviceId, id));
  if ((usage?.n ?? 0) > 0) {
    throw new AdminError(
      "in_use",
      "This service is on existing bookings, so it can't be deleted. Deactivate it instead to hide it from booking.",
    );
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ name: service.name }).from(service).where(eq(service.id, id));
    if (!row) throw new AdminError("not_found", "Service not found.");
    await tx.delete(service).where(eq(service.id, id));
    await recordAudit(tx, {
      actor,
      action: "service.deleted",
      entityType: "service",
      entityId: id,
      data: { name: row.name },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                  */
/* -------------------------------------------------------------------------- */

export async function saveLocation(
  db: Db,
  actor: Actor,
  input: LocationInput,
): Promise<{ id: string }> {
  const biz = await getBusiness(db);
  const values = {
    name: input.name,
    addressLine: input.addressLine,
    suburb: input.suburb,
    state: input.state,
    postcode: input.postcode,
    phone: input.phone,
    arrivalNote: input.arrivalNote,
    active: input.active,
    sortOrder: input.sortOrder,
  };
  return db.transaction(async (tx) => {
    let id = input.id;
    if (id) {
      const updated = await tx
        .update(location)
        .set(values)
        .where(eq(location.id, id))
        .returning({ id: location.id });
      if (updated.length === 0) throw new AdminError("not_found", "Location not found.");
    } else {
      const [created] = await tx
        .insert(location)
        .values({ ...values, businessId: biz.id })
        .returning({ id: location.id });
      id = created?.id;
      if (!id) throw new Error("Insert returned no row");
    }
    await recordAudit(tx, {
      actor,
      action: input.id ? "location.updated" : "location.created",
      entityType: "location",
      entityId: id,
      data: { name: input.name, active: input.active },
    });
    return { id };
  });
}

export async function deleteLocation(db: Db, actor: Actor, id: string): Promise<void> {
  const [usage] = await db.select({ n: count() }).from(booking).where(eq(booking.locationId, id));
  if ((usage?.n ?? 0) > 0) {
    throw new AdminError(
      "in_use",
      "This location has bookings, so it can't be deleted. Deactivate it instead to stop new bookings.",
    );
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ name: location.name })
      .from(location)
      .where(eq(location.id, id));
    if (!row) throw new AdminError("not_found", "Location not found.");
    await tx.delete(location).where(eq(location.id, id));
    await recordAudit(tx, {
      actor,
      action: "location.deleted",
      entityType: "location",
      entityId: id,
      data: { name: row.name },
    });
  });
}
