import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { booking, webhookEvent } from "@/db/schema";
import { getAccount } from "../common/account-store";
import { ensureWatchChannel } from "./channel";
import { syncGoogleCalendar } from "./inbound";
import { handleGoogleDomainEvent, pushBookingToCalendar } from "./outbound";
import type { GoogleDeps } from "./runtime";

export const GOOGLE_JOBS = {
  consumer: "consumer.google",
  sync: "google.sync",
  renewChannel: "google.channel.renew",
  reconcile: "google.reconcile",
} as const;

export const GOOGLE_SCHEDULES = {
  sync: "*/15 * * * *",
  renewChannel: "7 */6 * * *",
  reconcile: "23 * * * *",
} as const;

const WEBHOOK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECONCILE_BATCH = 25;
const GONE_STATUSES = [
  "cancelled_by_client",
  "cancelled_by_staff",
  "late_cancelled",
  "no_show",
  "expired",
] as const;

/** Fallback poll (every 15 minutes): covers a missed push, a lapsed channel and first connection. */
export async function runGoogleSyncJob(deps: GoogleDeps): Promise<void> {
  await syncGoogleCalendar(deps);
  await ensureWatchChannel(deps);
  await deps.db
    .delete(webhookEvent)
    .where(
      and(
        eq(webhookEvent.provider, "google"),
        lt(webhookEvent.receivedAt, new Date(deps.now().getTime() - WEBHOOK_RETENTION_MS)),
      ),
    );
}

/** Channels live at most about a week; this makes sure a new one exists before the old lapses. */
export async function runChannelRenewalJob(deps: GoogleDeps): Promise<void> {
  const result = await ensureWatchChannel(deps);
  // Anything that changed while the old channel was winding down is picked up now.
  if (result.action === "created" || result.action === "renewed") await syncGoogleCalendar(deps);
}

/**
 * Backstop for dropped events (revoked token, exhausted retries): re-push future bookings that
 * have no calendar event and remove events of bookings that are no longer live. Idempotent.
 */
export async function runGoogleReconcile(deps: GoogleDeps): Promise<number> {
  const account = await getAccount(deps.db, "google");
  if (!account || account.status !== "connected") return 0;

  const missing = await deps.db
    .select({ id: booking.id })
    .from(booking)
    .where(
      and(
        eq(booking.status, "confirmed"),
        isNull(booking.gcalEventId),
        sql`upper(${booking.during}) > ${deps.now()}`,
      ),
    )
    .limit(RECONCILE_BATCH);
  for (const row of missing) await pushBookingToCalendar(deps, row.id);

  const orphaned = await deps.db
    .select({ id: booking.id })
    .from(booking)
    .where(and(inArray(booking.status, GONE_STATUSES), isNotNull(booking.gcalEventId)))
    .limit(RECONCILE_BATCH);
  for (const row of orphaned) {
    await handleGoogleDomainEvent(deps, { type: "booking.cancelled", bookingId: row.id });
  }
  return missing.length + orphaned.length;
}
