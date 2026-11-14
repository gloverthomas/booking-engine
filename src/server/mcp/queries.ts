import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  booking,
  bookingService,
  client,
  location,
  messageLog,
  payment,
  service,
  staff,
} from "@/db/schema";
import type { Db } from "../db-types";
import { McpToolError } from "./errors";

export type BookingStatusValue = (typeof booking.$inferSelect)["status"];

const startOf = sql<Date>`lower(${booking.during})`.mapWith((v) => new Date(v as string));

export interface BookingListRow {
  bookingId: string;
  status: BookingStatusValue;
  start: Date;
  end: Date;
  locationId: string;
  locationName: string;
  clientId: string;
  firstName: string;
  lastName: string;
  totalCents: number;
  depositCents: number;
  services: string[];
}

/** Bookings starting in [from, to), newest last. Services are joined in a second query so rows stay one per booking. */
export async function queryBookings(
  db: Db,
  input: {
    from: Date;
    to: Date;
    locationId?: string;
    statuses?: BookingStatusValue[];
    limit: number;
  },
): Promise<{ rows: BookingListRow[]; hasMore: boolean }> {
  const conditions = [gte(startOf, input.from), lt(startOf, input.to)];
  if (input.locationId) conditions.push(eq(booking.locationId, input.locationId));
  if (input.statuses && input.statuses.length > 0)
    conditions.push(inArray(booking.status, input.statuses));

  const rows = await db
    .select({
      bookingId: booking.id,
      status: booking.status,
      during: booking.during,
      locationId: booking.locationId,
      locationName: location.name,
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
      totalCents: booking.totalCents,
      depositCents: booking.depositCents,
    })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .innerJoin(client, eq(client.id, booking.clientId))
    .where(and(...conditions))
    .orderBy(asc(startOf))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const ids = page.map((r) => r.bookingId);
  const lines =
    ids.length === 0
      ? []
      : await db
          .select({ bookingId: bookingService.bookingId, name: bookingService.name })
          .from(bookingService)
          .where(inArray(bookingService.bookingId, ids))
          .orderBy(asc(bookingService.position));

  return {
    hasMore: rows.length > input.limit,
    rows: page.map((r) => ({
      bookingId: r.bookingId,
      status: r.status,
      start: r.during.start,
      end: r.during.end,
      locationId: r.locationId,
      locationName: r.locationName,
      clientId: r.clientId,
      firstName: r.firstName,
      lastName: r.lastName,
      totalCents: r.totalCents,
      depositCents: r.depositCents,
      services: lines.filter((l) => l.bookingId === r.bookingId).map((l) => l.name),
    })),
  };
}

export async function loadBookingDetail(db: Db, bookingId: string) {
  const [row] = await db
    .select({
      b: booking,
      locationName: location.name,
      staffName: staff.name,
      client,
    })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .innerJoin(staff, eq(staff.id, booking.staffId))
    .innerJoin(client, eq(client.id, booking.clientId))
    .where(eq(booking.id, bookingId));
  if (!row) throw new McpToolError("not_found", "No booking with that id.");

  const [services, payments, messages] = await Promise.all([
    db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, bookingId))
      .orderBy(asc(bookingService.position)),
    db
      .select()
      .from(payment)
      .where(eq(payment.bookingId, bookingId))
      .orderBy(asc(payment.createdAt)),
    db
      .select({
        channel: messageLog.channel,
        template: messageLog.template,
        status: messageLog.status,
        createdAt: messageLog.createdAt,
      })
      .from(messageLog)
      .where(eq(messageLog.bookingId, bookingId))
      .orderBy(asc(messageLog.createdAt))
      .limit(50),
  ]);
  return { ...row, services, payments, messages };
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Case-insensitive match on name, email or phone. LIKE wildcards in the query are escaped, so "%" matches nothing special. */
export async function searchClients(db: Db, query: string, limit: number) {
  const pattern = `%${escapeLike(query.trim())}%`;
  const digits = query.replace(/\D/g, "");
  // Phones are stored as E.164 (+614...), so a local "0410 ..." search drops its leading zero.
  const national = digits.startsWith("0") ? digits.slice(1) : digits;
  const phonePattern = national.length >= 3 ? `%${national}%` : null;
  const matches = [
    ilike(sql`${client.firstName} || ' ' || ${client.lastName}`, pattern),
    ilike(client.email, pattern),
    ...(phonePattern ? [ilike(client.phone, phonePattern)] : []),
  ];
  return db
    .select()
    .from(client)
    .where(and(isNull(client.mergedIntoId), or(...matches)))
    .orderBy(asc(client.firstName), asc(client.lastName))
    .limit(limit);
}

export async function loadClient(db: Db, clientId: string) {
  const [row] = await db.select().from(client).where(eq(client.id, clientId));
  if (!row) throw new McpToolError("not_found", "No client with that id.");
  return row;
}

export async function loadClientBookings(db: Db, clientId: string, limit: number) {
  const rows = await db
    .select({
      bookingId: booking.id,
      status: booking.status,
      during: booking.during,
      locationName: location.name,
      totalCents: booking.totalCents,
    })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(eq(booking.clientId, clientId))
    .orderBy(desc(startOf))
    .limit(limit);
  const ids = rows.map((r) => r.bookingId);
  const lines =
    ids.length === 0
      ? []
      : await db
          .select({ bookingId: bookingService.bookingId, name: bookingService.name })
          .from(bookingService)
          .where(inArray(bookingService.bookingId, ids));
  return rows.map((r) => ({
    ...r,
    services: lines.filter((l) => l.bookingId === r.bookingId).map((l) => l.name),
  }));
}

export async function loadServices(db: Db, includeInactive: boolean) {
  return db
    .select()
    .from(service)
    .where(includeInactive ? undefined : eq(service.active, true))
    .orderBy(asc(service.sortOrder), asc(service.name));
}
