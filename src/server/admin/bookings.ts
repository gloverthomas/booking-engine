import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import {
  auditLog,
  booking,
  bookingService,
  client,
  location,
  messageLog,
  payment,
  staff,
} from "@/db/schema";
import type { Db } from "../db-types";
import {
  clientMatches,
  fullName,
  getBusinessContext,
  loadServiceNames,
  lowerOf,
  netPaidCents,
  upperOf,
} from "./shared";
import type {
  BookingDetail,
  BookingDetailPayment,
  BookingListFilter,
  BookingListRow,
  BookingStatus,
  CheckoutView,
} from "./types";

const LIVE_STATUSES: BookingStatus[] = ["pending_payment", "confirmed"];
const CANCELLED_STATUSES: BookingStatus[] = [
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
];

function toPaymentView(p: typeof payment.$inferSelect): BookingDetailPayment {
  return {
    id: p.id,
    kind: p.kind,
    method: p.method,
    status: p.status,
    amountCents: p.amountCents,
    note: p.note,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function getBookingDetail(
  db: Db,
  bookingId: string,
  now: Date = new Date(),
): Promise<BookingDetail | null> {
  const [row] = await db
    .select({
      booking,
      client,
      locationName: location.name,
      staffName: staff.name,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .innerJoin(location, eq(location.id, booking.locationId))
    .innerJoin(staff, eq(staff.id, booking.staffId))
    .where(eq(booking.id, bookingId));
  if (!row) return null;
  const b = row.booking;

  const [services, payments, messages, audit] = await Promise.all([
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
      .select()
      .from(messageLog)
      .where(eq(messageLog.bookingId, bookingId))
      .orderBy(desc(messageLog.createdAt)),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "booking"), eq(auditLog.entityId, bookingId)))
      .orderBy(desc(auditLog.at)),
  ]);

  const paidCents = netPaidCents(payments);
  const isLive = LIVE_STATUSES.includes(b.status);
  const isConfirmed = b.status === "confirmed";

  return {
    id: b.id,
    status: b.status,
    start: b.during.start.toISOString(),
    end: b.during.end.toISOString(),
    source: b.source,
    comments: b.comments,
    bookedForOther: b.bookedForOther,
    intakeAnswers: b.intakeAnswers,
    cancelReason: b.cancelReason,
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    location: { id: b.locationId, name: row.locationName },
    staff: { id: b.staffId, name: row.staffName },
    client: {
      id: row.client.id,
      name: fullName(row.client.firstName, row.client.lastName),
      phone: row.client.phone,
      email: row.client.email,
      notes: row.client.notes,
      blocked: row.client.blocked,
      isVip: row.client.isVip,
    },
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
    })),
    totalCents: b.totalCents,
    depositCents: b.depositCents,
    paidCents,
    balanceDueCents: b.status === "completed" ? 0 : Math.max(0, b.totalCents - paidCents),
    payments: payments.map(toPaymentView),
    messages: messages.map((m) => ({
      id: m.id,
      channel: m.channel,
      template: m.template,
      status: m.status,
      toAddress: m.toAddress,
      error: m.error,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
    })),
    audit: audit.map((a) => ({
      id: a.id,
      actor: a.actor,
      action: a.action,
      data: a.data,
      at: a.at.toISOString(),
    })),
    allowed: {
      move: isLive,
      cancel: isLive,
      noShow: isConfirmed && b.during.start.getTime() <= now.getTime(),
      checkout: isConfirmed,
      resend: isConfirmed,
    },
  };
}

export interface ListBookingsOptions {
  filter: BookingListFilter;
  q?: string;
  limit?: number;
  now?: Date;
}

export async function listBookings(
  db: Db,
  options: ListBookingsOptions,
): Promise<BookingListRow[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;

  const byFilter = {
    upcoming: {
      where: and(
        inArray(booking.status, LIVE_STATUSES),
        gt(upperOf(booking.during), now.toISOString()),
      ),
      order: asc(lowerOf(booking.during)),
    },
    past: {
      where: and(
        inArray(booking.status, ["confirmed", "completed", "no_show"]),
        lte(upperOf(booking.during), now.toISOString()),
      ),
      order: desc(lowerOf(booking.during)),
    },
    cancelled: {
      where: inArray(booking.status, CANCELLED_STATUSES),
      order: desc(lowerOf(booking.during)),
    },
  }[options.filter];

  const rows = await db
    .select({
      id: booking.id,
      status: booking.status,
      during: booking.during,
      totalCents: booking.totalCents,
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
      locationName: location.name,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(and(byFilter.where, options.q ? clientMatches(options.q) : undefined))
    .orderBy(byFilter.order)
    .limit(limit);

  const names = await loadServiceNames(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toListRow(r, names.get(r.id) ?? []));
}

export function toListRow(
  r: {
    id: string;
    status: BookingStatus;
    during: { start: Date; end: Date };
    totalCents: number;
    clientId: string;
    firstName: string;
    lastName: string;
    locationName: string;
  },
  services: string[],
): BookingListRow {
  return {
    id: r.id,
    start: r.during.start.toISOString(),
    end: r.during.end.toISOString(),
    status: r.status,
    clientId: r.clientId,
    clientName: fullName(r.firstName, r.lastName),
    locationName: r.locationName,
    services,
    totalCents: r.totalCents,
  };
}

/** Everything the checkout screen needs. Null when the booking does not exist. */
export async function getCheckoutView(
  db: Db,
  bookingId: string,
  _now: Date = new Date(),
): Promise<CheckoutView | null> {
  const [row] = await db
    .select({
      id: booking.id,
      status: booking.status,
      during: booking.during,
      totalCents: booking.totalCents,
      firstName: client.firstName,
      lastName: client.lastName,
      locationName: location.name,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(eq(booking.id, bookingId));
  if (!row) return null;

  const [services, payments, ctx] = await Promise.all([
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
    getBusinessContext(db),
  ]);

  const paidCents = netPaidCents(payments);
  return {
    bookingId: row.id,
    status: row.status,
    start: row.during.start.toISOString(),
    clientName: fullName(row.firstName, row.lastName),
    locationName: row.locationName,
    services: services.map((s) => ({ name: s.name, priceCents: s.priceCents })),
    totalCents: row.totalCents,
    paidCents,
    cashDiscountPct: ctx.settings.cashDiscountPct,
    balanceAlreadyRecorded: payments.some((p) => p.kind === "balance" && p.status === "succeeded"),
    receipt:
      row.status === "completed" ? { payments: payments.map(toPaymentView), paidCents } : null,
  };
}
