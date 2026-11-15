import { and, asc, eq, inArray } from "drizzle-orm";
import {
  booking,
  bookingService,
  business,
  location,
  service,
  serviceLocation,
  staff,
} from "@/db/schema";
import type { Db } from "@/server/db-types";
import { parseSettings, type BusinessSettings } from "@/server/settings";
import { loadStaffByLocation } from "./public-api-catalog-staff";
import { todayIn } from "./public-api-slots";
import type {
  CatalogData,
  CatalogLocation,
  CatalogService,
  CatalogStaff,
} from "./public-api-types";

export interface BusinessContext {
  id: string;
  name: string;
  timezone: string;
  settings: BusinessSettings;
}

/** Single-tenant: the first business row is the business. */
export async function loadBusiness(db: Db): Promise<BusinessContext> {
  const [row] = await db.select().from(business).orderBy(asc(business.createdAt)).limit(1);
  if (!row) throw new Error("No business configured");
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    settings: parseSettings(row.settings),
  };
}

function toCatalogService(
  row: typeof service.$inferSelect,
  defaultDepositPct: number,
): CatalogService {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    durationMin: row.durationMin,
    priceCents: row.priceCents,
    depositPct: row.depositPct ?? defaultDepositPct,
    intakeQuestions: row.intakeQuestions,
  };
}

/** Active locations with the services a stranger may book there (active, not VIP-only). */
export async function loadCatalog(db: Db, ctx: BusinessContext, now: Date): Promise<CatalogData> {
  const locations = await db
    .select()
    .from(location)
    .where(eq(location.active, true))
    .orderBy(asc(location.sortOrder), asc(location.name));

  const links = locations.length
    ? await db
        .select({ locationId: serviceLocation.locationId, svc: service })
        .from(serviceLocation)
        .innerJoin(service, eq(service.id, serviceLocation.serviceId))
        .where(
          and(
            inArray(
              serviceLocation.locationId,
              locations.map((l) => l.id),
            ),
            eq(service.active, true),
            eq(service.vipOnly, false),
          ),
        )
        .orderBy(asc(service.sortOrder), asc(service.name))
    : [];

  const today = todayIn(ctx.timezone, now);
  const servicesAt = (locationId: string) =>
    links.filter((link) => link.locationId === locationId).map((link) => link.svc);
  const staffAt = ctx.settings.chooseStaff
    ? await loadStaffByLocation(
        db,
        new Map(locations.map((loc) => [loc.id, servicesAt(loc.id)])),
        today,
      )
    : new Map<string, CatalogStaff[]>();

  const result: CatalogLocation[] = locations
    .map((loc) => ({
      id: loc.id,
      name: loc.name,
      addressLine: loc.addressLine,
      suburb: loc.suburb,
      state: loc.state,
      postcode: loc.postcode,
      arrivalNote: loc.arrivalNote,
      services: links
        .filter((link) => link.locationId === loc.id)
        .map((link) => toCatalogService(link.svc, ctx.settings.depositPct)),
      staff: staffAt.get(loc.id) ?? [],
    }))
    .filter((loc) => loc.services.length > 0);

  const { settings } = ctx;
  return {
    business: { name: ctx.name, timezone: ctx.timezone },
    today,
    maxAdvanceDays: settings.maxAdvanceDays,
    holdMinutes: settings.holdMinutes,
    chooseStaff: settings.chooseStaff,
    waitlistEnabled: settings.waitlistEnabled,
    policy: {
      version: settings.policyVersion,
      text: settings.policyText,
      cancelWindowHours: settings.cancelWindowHours,
      depositPct: settings.depositPct,
      refundOutsideWindow: settings.refundOutsideWindow,
    },
    locations: result,
  };
}

export interface BookingContext {
  locationId: string;
  locationName: string;
  address: string | null;
  arrivalNote: string | null;
  phone: string | null;
  serviceIds: string[];
  /** The stylist the booking is with. */
  staffId: string;
  staffName: string;
  /** True when the client chose this stylist rather than "first available". */
  staffRequested: boolean;
}

/**
 * What the manage page needs beyond PublicBookingSummary: where the booking is and which services
 * it holds, so a reschedule can query availability. Read-only; call only with an authenticated id.
 */
export async function loadBookingContext(
  db: Db,
  bookingId: string,
): Promise<BookingContext | null> {
  const [row] = await db
    .select({
      locationId: location.id,
      locationName: location.name,
      addressLine: location.addressLine,
      suburb: location.suburb,
      state: location.state,
      postcode: location.postcode,
      arrivalNote: location.arrivalNote,
      phone: location.phone,
      staffId: booking.staffId,
      staffName: staff.name,
      staffRequested: booking.staffRequested,
    })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .innerJoin(staff, eq(staff.id, booking.staffId))
    .where(eq(booking.id, bookingId));
  if (!row) return null;

  const services = await db
    .select({ serviceId: bookingService.serviceId })
    .from(bookingService)
    .where(eq(bookingService.bookingId, bookingId))
    .orderBy(asc(bookingService.position));

  const locality = [row.suburb, row.state, row.postcode].filter(Boolean).join(" ");
  const address = [row.addressLine, locality].filter(Boolean).join(", ");

  return {
    locationId: row.locationId,
    locationName: row.locationName,
    address: address || null,
    arrivalNote: row.arrivalNote,
    phone: row.phone,
    serviceIds: services.flatMap((s) => (s.serviceId ? [s.serviceId] : [])),
    staffId: row.staffId,
    staffName: row.staffName,
    staffRequested: row.staffRequested,
  };
}
