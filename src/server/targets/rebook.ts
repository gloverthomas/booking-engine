import { inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { booking, client } from "@/db/schema";
import type { Db } from "../db-types";
import { makeCanonical } from "../reports/clients";
import type { ResolvedRange } from "../reports/range";

export const DEFAULT_REBOOK_WINDOW_DAYS = 28;

export interface RebookCounts {
  /** Completed visits in the range whose rebook window has fully passed. */
  eligible: number;
  rebooked: number;
}

export interface RebookResult {
  /** Per stylist (the one who did the visit). */
  byStaff: Map<string, RebookCounts>;
  total: RebookCounts;
}

/**
 * Rebook rate inputs, defined exactly as the clients report defines it: a completed visit counts as rebooked
 * when the same person (merged duplicates rolled up) has another confirmed or completed appointment, with
 * anyone, starting after it and within `windowDays`. Only visits whose window has fully passed are counted,
 * so recent visits never drag the rate down. Credited to the stylist who did the visit.
 */
export async function getRebookCounts(
  db: Db,
  input: { range: ResolvedRange; now: Date; windowDays?: number; staffId?: string },
): Promise<RebookResult> {
  const windowDays = input.windowDays ?? DEFAULT_REBOOK_WINDOW_DAYS;
  const [clients, rows] = await Promise.all([
    db.select({ id: client.id, mergedIntoId: client.mergedIntoId }).from(client),
    db
      .select({
        clientId: booking.clientId,
        staffId: booking.staffId,
        status: booking.status,
        start: sql<Date>`lower(${booking.during})`.mapWith((v) => new Date(v as string)),
      })
      .from(booking)
      .where(inArray(booking.status, ["confirmed", "completed"])),
  ]);
  const canonical = makeCanonical(clients);
  const visits = rows.map((r) => ({ ...r, clientId: canonical(r.clientId) }));
  const startsByClient = new Map<string, number[]>();
  for (const v of visits) {
    startsByClient.set(v.clientId, [...(startsByClient.get(v.clientId) ?? []), v.start.getTime()]);
  }

  const byStaff = new Map<string, RebookCounts>();
  let eligible = 0;
  let rebooked = 0;
  for (const v of visits) {
    if (v.status !== "completed") continue;
    if (input.staffId && v.staffId !== input.staffId) continue;
    if (v.start < input.range.start || v.start >= input.range.endExclusive) continue;
    const windowEnd = DateTime.fromJSDate(v.start, { zone: input.range.timezone })
      .plus({ days: windowDays })
      .toMillis();
    if (windowEnd > input.now.getTime()) continue;
    const again = (startsByClient.get(v.clientId) ?? []).some(
      (s) => s > v.start.getTime() && s <= windowEnd,
    );
    const own = byStaff.get(v.staffId) ?? { eligible: 0, rebooked: 0 };
    byStaff.set(v.staffId, {
      eligible: own.eligible + 1,
      rebooked: own.rebooked + (again ? 1 : 0),
    });
    eligible += 1;
    rebooked += again ? 1 : 0;
  }
  return { byStaff, total: { eligible, rebooked } };
}
