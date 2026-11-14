import { and, eq, inArray, sql } from "drizzle-orm";
import { booking, client, location, payment } from "@/db/schema";
import type { Db } from "../db-types";
import { systemClock } from "../clock";

const COUNTED = ["succeeded", "partially_refunded", "refunded"] as const;
const TOWARDS_TOTAL = new Set(["deposit", "balance"]);

export interface OutstandingQuery {
  now?: Date;
  limit?: number;
}

export interface OutstandingRow {
  bookingId: string;
  start: Date;
  /** completed: the appointment happened and a balance is still owed. confirmed: balance due at the appointment. */
  state: "overdue" | "upcoming";
  status: "completed" | "confirmed";
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  locationName: string;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
}

export interface OutstandingReport {
  overdueCents: number;
  upcomingCents: number;
  overdueCount: number;
  upcomingCount: number;
  rows: OutstandingRow[];
}

/**
 * Bookings where deposit + balance received (minus refunds) is below the booking total.
 * Completed ones are overdue; confirmed ones whose appointment is still ahead just have their balance to come.
 * Late-cancel and no-show fees are not part of the booking total, so they never reduce what is owed.
 */
export async function getOutstandingReport(
  db: Db,
  query: OutstandingQuery = {},
): Promise<OutstandingReport> {
  const now = query.now ?? systemClock();
  const limit = query.limit ?? 500;

  const bookings = await db
    .select({
      bookingId: booking.id,
      status: booking.status,
      during: booking.during,
      totalCents: booking.totalCents,
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
      locationName: location.name,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(
      and(inArray(booking.status, ["completed", "confirmed"]), sql`${booking.totalCents} > 0`),
    );

  const payments = await db
    .select({
      bookingId: payment.bookingId,
      kind: payment.kind,
      amountCents: payment.amountCents,
    })
    .from(payment)
    .where(inArray(payment.status, [...COUNTED]));
  const netPaid = new Map<string, number>();
  for (const p of payments) {
    if (!p.bookingId) continue;
    if (!TOWARDS_TOTAL.has(p.kind) && p.kind !== "refund") continue;
    const signed = p.kind === "refund" ? -p.amountCents : p.amountCents;
    netPaid.set(p.bookingId, (netPaid.get(p.bookingId) ?? 0) + signed);
  }

  const rows: OutstandingRow[] = bookings.flatMap((b) => {
    const paid = netPaid.get(b.bookingId) ?? 0;
    const owed = b.totalCents - paid;
    if (owed <= 0) return [];
    const status = b.status as "completed" | "confirmed";
    const started = b.during.start <= now;
    // A confirmed booking whose time has passed but was never completed is also overdue.
    const state: OutstandingRow["state"] =
      status === "completed" || started ? "overdue" : "upcoming";
    return [
      {
        bookingId: b.bookingId,
        start: b.during.start,
        state,
        status,
        clientId: b.clientId,
        clientName: `${b.firstName} ${b.lastName}`.trim(),
        clientEmail: b.email,
        clientPhone: b.phone,
        locationName: b.locationName,
        totalCents: b.totalCents,
        paidCents: paid,
        outstandingCents: owed,
      },
    ];
  });

  rows.sort((a, b) => a.start.getTime() - b.start.getTime());
  const sum = (state: OutstandingRow["state"]) =>
    rows.filter((r) => r.state === state).reduce((s, r) => s + r.outstandingCents, 0);
  const count = (state: OutstandingRow["state"]) => rows.filter((r) => r.state === state).length;

  return {
    overdueCents: sum("overdue"),
    upcomingCents: sum("upcoming"),
    overdueCount: count("overdue"),
    upcomingCount: count("upcoming"),
    rows: rows.slice(0, limit),
  };
}
