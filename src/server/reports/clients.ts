import { and, gte, inArray, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { booking, client, payment } from "@/db/schema";
import type { Db } from "../db-types";
import { systemClock } from "../clock";
import { resolveRange, type ResolvedRange } from "./range";

export interface ClientsQuery {
  timezone: string;
  from: string;
  to: string;
  now?: Date;
  /** A completed visit counts as rebooked if the client has another appointment starting within this many days. */
  rebookWindowDays?: number;
  /** A client is lapsed when their last completed visit was more than this many days ago and nothing is booked. */
  lapsedDays?: number;
  topLimit?: number;
  lapsedLimit?: number;
}

export interface TopClientRow {
  clientId: string;
  name: string;
  email: string | null;
  visits: number;
  /** Money received in the range minus refunds. */
  spendCents: number;
  lastVisit: Date | null;
}

export interface LapsedClientRow {
  clientId: string;
  name: string;
  email: string | null;
  phone: string | null;
  lastVisit: Date;
  daysSinceLastVisit: number;
  lifetimeVisits: number;
}

export interface ClientsReport {
  range: ResolvedRange;
  /** Distinct clients with a confirmed or completed appointment in the range. */
  activeClients: number;
  /** Clients whose first ever appointment is in the range. */
  newClients: number;
  returningClients: number;
  rebook: {
    windowDays: number;
    /** Completed visits in the range old enough for the window to have fully elapsed. */
    eligibleVisits: number;
    rebookedVisits: number;
    ratePct: number | null;
  };
  topClients: TopClientRow[];
  lapsed: { thresholdDays: number; total: number; rows: LapsedClientRow[] };
}

const HONOURED = ["confirmed", "completed"] as const;
const COUNTED = ["succeeded", "partially_refunded", "refunded"] as const;
const MAX_MERGE_HOPS = 10;

/** Follow merged_into_id so a merged duplicate's history rolls up into the surviving client. */
export function makeCanonical(clients: ReadonlyArray<{ id: string; mergedIntoId: string | null }>) {
  const parent = new Map(clients.map((c) => [c.id, c.mergedIntoId]));
  return (id: string): string => {
    let current = id;
    for (let hops = 0; hops < MAX_MERGE_HOPS; hops += 1) {
      const next = parent.get(current);
      if (!next) return current;
      current = next;
    }
    return current;
  };
}

const fullName = (c: { firstName: string; lastName: string }): string =>
  `${c.firstName} ${c.lastName}`.trim();

/** New vs returning, rebook rate, top spenders and lapsed clients. Merged duplicates count as one person. */
export async function getClientsReport(db: Db, query: ClientsQuery): Promise<ClientsReport> {
  const range = resolveRange(query.timezone, query.from, query.to);
  const now = query.now ?? systemClock();
  const windowDays = query.rebookWindowDays ?? 28;
  const lapsedDays = query.lapsedDays ?? 90;
  const topLimit = query.topLimit ?? 10;
  const lapsedLimit = query.lapsedLimit ?? 50;

  const [clients, bookings] = await Promise.all([
    db.select().from(client),
    db
      .select({
        clientId: booking.clientId,
        status: booking.status,
        start: sql<Date>`lower(${booking.during})`.mapWith((v) => new Date(v as string)),
      })
      .from(booking)
      .where(inArray(booking.status, [...HONOURED])),
  ]);
  const canonical = makeCanonical(clients);
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const visits = bookings
    .map((b) => ({ clientId: canonical(b.clientId), status: b.status, start: b.start }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const byClient = new Map<string, typeof visits>();
  for (const v of visits) byClient.set(v.clientId, [...(byClient.get(v.clientId) ?? []), v]);

  const inRange = (d: Date) => d >= range.start && d < range.endExclusive;
  const rangeVisits = visits.filter((v) => inRange(v.start));
  const activeIds = new Set(rangeVisits.map((v) => v.clientId));
  const newIds = [...activeIds].filter((id) => {
    const first = byClient.get(id)?.[0];
    return first !== undefined && inRange(first.start);
  });

  // Rebook rate over completed visits whose window has fully elapsed.
  const windowEnd = (start: Date) =>
    DateTime.fromJSDate(start, { zone: range.timezone }).plus({ days: windowDays }).toJSDate();
  const cohort = rangeVisits.filter((v) => v.status === "completed" && windowEnd(v.start) <= now);
  const rebooked = cohort.filter((v) => {
    const end = windowEnd(v.start);
    return (byClient.get(v.clientId) ?? []).some((o) => o.start > v.start && o.start <= end);
  });

  // Top clients by money received in the range.
  const paid = await db
    .select({
      clientId: booking.clientId,
      kind: payment.kind,
      amountCents: payment.amountCents,
    })
    .from(payment)
    .innerJoin(booking, sql`${booking.id} = ${payment.bookingId}`)
    .where(
      and(
        gte(payment.createdAt, range.start),
        lt(payment.createdAt, range.endExclusive),
        inArray(payment.status, [...COUNTED]),
      ),
    );
  const spend = new Map<string, number>();
  for (const p of paid) {
    const id = canonical(p.clientId);
    const signed = p.kind === "refund" ? -p.amountCents : p.amountCents;
    spend.set(id, (spend.get(id) ?? 0) + signed);
  }
  const topClients: TopClientRow[] = [...spend]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topLimit)
    .map(([id, cents]) => {
      const c = clientById.get(id);
      const own = byClient.get(id) ?? [];
      return {
        clientId: id,
        name: c ? fullName(c) : "Unknown client",
        email: c?.email ?? null,
        visits: own.filter((v) => inRange(v.start)).length,
        spendCents: cents,
        lastVisit: own.filter((v) => v.start <= now).at(-1)?.start ?? null,
      };
    });

  // Lapsed: last completed visit older than the threshold and nothing booked ahead.
  const cutoff = DateTime.fromJSDate(now, { zone: range.timezone }).minus({ days: lapsedDays });
  const today = DateTime.fromJSDate(now, { zone: range.timezone }).startOf("day");
  const lapsedAll: LapsedClientRow[] = [];
  for (const [id, list] of byClient) {
    const c = clientById.get(id);
    if (!c || c.blocked || c.mergedIntoId) continue;
    if (list.some((v) => v.start > now)) continue;
    const completed = list.filter((v) => v.status === "completed");
    const last = completed.at(-1);
    if (!last || DateTime.fromJSDate(last.start) > cutoff) continue;
    lapsedAll.push({
      clientId: id,
      name: fullName(c),
      email: c.email,
      phone: c.phone,
      lastVisit: last.start,
      daysSinceLastVisit: Math.floor(
        today.diff(DateTime.fromJSDate(last.start, { zone: range.timezone }).startOf("day"), "days")
          .days,
      ),
      lifetimeVisits: completed.length,
    });
  }
  lapsedAll.sort((a, b) => b.lastVisit.getTime() - a.lastVisit.getTime());

  return {
    range,
    activeClients: activeIds.size,
    newClients: newIds.length,
    returningClients: activeIds.size - newIds.length,
    rebook: {
      windowDays,
      eligibleVisits: cohort.length,
      rebookedVisits: rebooked.length,
      ratePct: cohort.length > 0 ? Math.round((rebooked.length / cohort.length) * 1000) / 10 : null,
    },
    topClients,
    lapsed: {
      thresholdDays: lapsedDays,
      total: lapsedAll.length,
      rows: lapsedAll.slice(0, lapsedLimit),
    },
  };
}
