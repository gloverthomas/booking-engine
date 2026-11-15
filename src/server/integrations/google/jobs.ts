import { and, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { booking, webhookEvent } from "@/db/schema";
import { listAccounts } from "../common/account-store";
import { ensureWatchChannel } from "./channel";
import { syncAllGoogleAccounts, syncGoogleCalendar } from "./inbound";
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

async function connectedAccounts(deps: GoogleDeps) {
  return (await listAccounts(deps.db, "google")).filter((a) => a.status === "connected");
}

/**
 * Fallback poll (every 15 minutes): covers a missed push, a lapsed channel and first connection.
 * Runs once per connected account (the business-wide calendar and each stylist's); one failing
 * never stops the rest, and the first failure is rethrown afterwards.
 */
export async function runGoogleSyncJob(deps: GoogleDeps): Promise<void> {
  let failure: unknown;
  try {
    await syncAllGoogleAccounts(deps);
  } catch (error) {
    failure ??= error;
  }
  for (const account of await connectedAccounts(deps)) {
    try {
      await ensureWatchChannel(deps, { staffId: account.staffId });
    } catch (error) {
      failure ??= error;
    }
  }
  await deps.db
    .delete(webhookEvent)
    .where(
      and(
        eq(webhookEvent.provider, "google"),
        lt(webhookEvent.receivedAt, new Date(deps.now().getTime() - WEBHOOK_RETENTION_MS)),
      ),
    );
  if (failure) throw failure;
}

/** Channels live at most about a week; this makes sure a new one exists before the old lapses. */
export async function runChannelRenewalJob(deps: GoogleDeps): Promise<void> {
  let failure: unknown;
  for (const account of await connectedAccounts(deps)) {
    try {
      const result = await ensureWatchChannel(deps, { staffId: account.staffId });
      // Anything that changed while the old channel was winding down is picked up now.
      if (result.action === "created" || result.action === "renewed") {
        await syncGoogleCalendar(deps, { staffId: account.staffId });
      }
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/**
 * Backstop for dropped events (revoked token, exhausted retries): re-push future bookings that
 * have no calendar event and remove events of bookings that are no longer live. Idempotent.
 * Only bookings that can actually land somewhere are considered: with no business-wide calendar,
 * that means bookings of stylists who have connected their own.
 */
export async function runGoogleReconcile(deps: GoogleDeps): Promise<number> {
  const accounts = await connectedAccounts(deps);
  if (accounts.length === 0) return 0;

  const hasBusinessWide = accounts.some((a) => a.staffId === null);
  const stylistIds = accounts.flatMap((a) => (a.staffId ? [a.staffId] : []));
  const reachable: SQL | undefined = hasBusinessWide
    ? undefined
    : inArray(booking.staffId, stylistIds);

  const missing = await deps.db
    .select({ id: booking.id })
    .from(booking)
    .where(
      and(
        eq(booking.status, "confirmed"),
        isNull(booking.gcalEventId),
        sql`upper(${booking.during}) > ${deps.now()}`,
        reachable,
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
