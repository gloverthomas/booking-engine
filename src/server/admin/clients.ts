import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { booking, client, location, payment } from "@/db/schema";
import { recordAudit, type Actor } from "../audit";
import type { Db } from "../db-types";
import { toListRow } from "./bookings";
import { AdminError } from "./errors";
import { clientMatches, fullName, loadServiceNames, netPaidCents } from "./shared";
import type { ClientProfile, ClientSummary } from "./types";

const HISTORY_LIMIT = 50;
const MAX_NOTES_LENGTH = 4000;

export interface SearchClientsOptions {
  q: string;
  limit?: number;
}

/** Active (not merged away) clients, best match first by name. */
export async function searchClients(
  db: Db,
  options: SearchClientsOptions,
): Promise<ClientSummary[]> {
  const rows = await db
    .select()
    .from(client)
    .where(and(isNull(client.mergedIntoId), clientMatches(options.q)))
    .orderBy(asc(client.firstName), asc(client.lastName))
    .limit(options.limit ?? 25);

  return rows.map((c) => ({
    id: c.id,
    name: fullName(c.firstName, c.lastName),
    email: c.email,
    phone: c.phone,
    isVip: c.isVip,
    blocked: c.blocked,
  }));
}

export async function getClientProfile(
  db: Db,
  clientId: string,
  now: Date = new Date(),
): Promise<ClientProfile | null> {
  const [row] = await db.select().from(client).where(eq(client.id, clientId));
  if (!row) return null;

  const bookings = await db
    .select({
      id: booking.id,
      status: booking.status,
      during: booking.during,
      totalCents: booking.totalCents,
      locationName: location.name,
    })
    .from(booking)
    .innerJoin(location, eq(location.id, booking.locationId))
    .where(eq(booking.clientId, clientId));
  bookings.sort((a, b) => b.during.start.getTime() - a.during.start.getTime());

  const payments =
    bookings.length === 0
      ? []
      : await db
          .select()
          .from(payment)
          .where(
            inArray(
              payment.bookingId,
              bookings.map((b) => b.id),
            ),
          );

  const count = (status: string) => bookings.filter((b) => b.status === status).length;
  const recent = bookings.slice(0, HISTORY_LIMIT);
  const names = await loadServiceNames(
    db,
    recent.map((b) => b.id),
  );

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    name: fullName(row.firstName, row.lastName),
    email: row.email,
    phone: row.phone,
    pronouns: row.pronouns,
    notes: row.notes,
    blocked: row.blocked,
    isVip: row.isVip,
    marketingOptIn: row.marketingOptIn,
    createdAt: row.createdAt.toISOString(),
    mergedIntoId: row.mergedIntoId,
    stats: {
      completedCount: count("completed"),
      noShowCount: count("no_show"),
      lateCancelCount: count("late_cancelled"),
      cancelledCount: count("cancelled_by_client") + count("cancelled_by_staff"),
      upcomingCount: bookings.filter(
        (b) =>
          (b.status === "confirmed" || b.status === "pending_payment") &&
          b.during.end.getTime() > now.getTime(),
      ).length,
      lifetimeSpendCents: netPaidCents(payments),
    },
    history: recent.map((b) =>
      toListRow(
        {
          ...b,
          clientId: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
        },
        names.get(b.id) ?? [],
      ),
    ),
  };
}

async function updateClient(
  db: Db,
  clientId: string,
  values: Partial<typeof client.$inferInsert>,
  audit: { action: string; actor: Actor; data?: Record<string, unknown> },
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(client)
      .set(values)
      .where(eq(client.id, clientId))
      .returning({ id: client.id });
    if (updated.length === 0) throw new AdminError("That client was not found");
    await recordAudit(tx, {
      actor: audit.actor,
      action: audit.action,
      entityType: "client",
      entityId: clientId,
      data: audit.data,
    });
  });
}

/** Notes can hold personal detail, so the audit row records only that they changed and how long they are. */
export async function updateClientNotes(
  db: Db,
  clientId: string,
  notes: string,
  actor: Actor,
): Promise<void> {
  const trimmed = notes.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw new AdminError(`Notes are limited to ${MAX_NOTES_LENGTH} characters`);
  }
  await updateClient(
    db,
    clientId,
    { notes: trimmed || null },
    { action: "client.notes_updated", actor, data: { length: trimmed.length } },
  );
}

export async function setClientBlocked(
  db: Db,
  clientId: string,
  blocked: boolean,
  actor: Actor,
): Promise<void> {
  await updateClient(
    db,
    clientId,
    { blocked },
    {
      action: "client.blocked_changed",
      actor,
      data: { blocked },
    },
  );
}

export async function setClientVip(
  db: Db,
  clientId: string,
  isVip: boolean,
  actor: Actor,
): Promise<void> {
  await updateClient(
    db,
    clientId,
    { isVip },
    {
      action: "client.vip_changed",
      actor,
      data: { isVip },
    },
  );
}
