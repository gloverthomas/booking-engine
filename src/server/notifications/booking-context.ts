import { and, asc, eq, inArray } from "drizzle-orm";
import { booking, bookingService, business, client, location, payment, staff } from "@/db/schema";
import { parseSettings, type BusinessSettings } from "../settings";
import type { Db } from "../db-types";

const DEFAULT_TIMEZONE = "Australia/Melbourne";

export interface BookingContext {
  bookingId: string;
  status: (typeof booking.$inferSelect)["status"];
  start: Date;
  /** Start plus the services' own durations (the booking range also includes the hidden buffer). */
  end: Date;
  totalCents: number;
  comments: string | null;
  /** What the client has actually paid as a deposit (succeeded, possibly refunded since). */
  depositPaidCents: number;
  balanceDueCents: number;
  services: Array<{ name: string; priceCents: number; durationMin: number }>;
  client: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
  };
  location: { name: string; address: string; arrivalNote: string | null; phone: string | null };
  staffName: string;
  staffId: string;
  /** The stylist's own contact details, for staff alerts. Never shown to clients. */
  staffEmail: string | null;
  staffPhone: string | null;
  businessName: string;
  timezone: string;
  settings: BusinessSettings;
}

const DEPOSIT_STATUSES = ["succeeded", "partially_refunded", "refunded"] as const;

function formatAddress(row: typeof location.$inferSelect): string {
  const region = [row.state, row.postcode].filter(Boolean).join(" ");
  return [row.addressLine, [row.suburb, region].filter(Boolean).join(" ")]
    .filter((part) => part && part.length > 0)
    .join(", ");
}

/** Everything a message needs about a booking, in one read. Returns null when the booking is gone. */
export async function loadBookingContext(
  db: Db,
  bookingId: string,
): Promise<BookingContext | null> {
  const [row] = await db
    .select({
      booking,
      client,
      location,
      staffName: staff.name,
      staffEmail: staff.email,
      staffPhone: staff.phone,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .innerJoin(location, eq(location.id, booking.locationId))
    .innerJoin(staff, eq(staff.id, booking.staffId))
    .where(eq(booking.id, bookingId));
  if (!row) return null;

  const [biz] = row.location.businessId
    ? await db.select().from(business).where(eq(business.id, row.location.businessId))
    : await db.select().from(business).limit(1);

  const services = await db
    .select()
    .from(bookingService)
    .where(eq(bookingService.bookingId, bookingId))
    .orderBy(asc(bookingService.position));

  const deposits = await db
    .select({ amountCents: payment.amountCents })
    .from(payment)
    .where(
      and(
        eq(payment.bookingId, bookingId),
        eq(payment.kind, "deposit"),
        inArray(payment.status, [...DEPOSIT_STATUSES]),
      ),
    );
  const depositPaidCents = deposits.reduce((sum, d) => sum + d.amountCents, 0);

  const start = row.booking.during.start;
  const durationMin = services.reduce((sum, s) => sum + s.durationMin, 0);
  const end =
    durationMin > 0 ? new Date(start.getTime() + durationMin * 60_000) : row.booking.during.end;

  return {
    bookingId,
    status: row.booking.status,
    start,
    end,
    totalCents: row.booking.totalCents,
    comments: row.booking.comments,
    depositPaidCents,
    balanceDueCents: Math.max(0, row.booking.totalCents - depositPaidCents),
    services: services.map((s) => ({
      name: s.name,
      priceCents: s.priceCents,
      durationMin: s.durationMin,
    })),
    client: {
      id: row.client.id,
      firstName: row.client.firstName,
      lastName: row.client.lastName,
      email: row.client.email,
      phone: row.client.phone,
    },
    location: {
      name: row.location.name,
      address: formatAddress(row.location),
      arrivalNote: row.location.arrivalNote,
      phone: row.location.phone,
    },
    staffName: row.staffName,
    staffId: row.booking.staffId,
    staffEmail: row.staffEmail,
    staffPhone: row.staffPhone,
    businessName: biz?.name ?? row.staffName,
    timezone: biz?.timezone ?? DEFAULT_TIMEZONE,
    settings: parseSettings(biz?.settings),
  };
}
