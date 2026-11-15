import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { waitlistEntry, waitlistOffer } from "@/db/schema";
import type { Db } from "../db-types";
import { ACTIVE_ENTRY_STATUSES } from "./shared";

/**
 * Entries that read "offered" but no longer have a live reason to: every offer lapsed, was taken or was
 * withdrawn, and no claimed booking is pending or confirmed. They go back to "waiting" if their date
 * window still has time. Returns how many went back.
 */
export async function revertIdleEntries(db: Db, now: Date): Promise<number> {
  const reverted = await db
    .update(waitlistEntry)
    .set({ status: "waiting", updatedAt: now })
    .where(
      and(
        eq(waitlistEntry.status, "offered"),
        gt(waitlistEntry.expiresAt, now),
        sql`not exists (
          select 1 from waitlist_offer o
          where o.entry_id = waitlist_entry.id
            and o.status = 'sent'
            and o.expires_at > ${now.toISOString()}::timestamptz
        )`,
        sql`not exists (
          select 1 from waitlist_offer o
          join booking b on b.id = o.claimed_booking_id
          where o.entry_id = waitlist_entry.id
            and o.status = 'claimed'
            and b.status in ('pending_payment', 'confirmed')
        )`,
      ),
    )
    .returning({ id: waitlistEntry.id });
  return reverted.length;
}

/**
 * Housekeeping, run hourly: offers past their window become expired; entries past their last date
 * become expired (with any open offers); entries whose offers all lapsed or were taken go back to
 * waiting while their window still has time. Returns how many rows changed. Safe to run any time.
 */
export async function expireWaitlist(db: Db, now: Date = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    const lapsedOffers = await tx
      .update(waitlistOffer)
      .set({ status: "expired" })
      .where(and(eq(waitlistOffer.status, "sent"), lte(waitlistOffer.expiresAt, now)))
      .returning({ id: waitlistOffer.id });

    const lapsedEntries = await tx
      .update(waitlistEntry)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          inArray(waitlistEntry.status, [...ACTIVE_ENTRY_STATUSES]),
          lte(waitlistEntry.expiresAt, now),
        ),
      )
      .returning({ id: waitlistEntry.id });
    if (lapsedEntries.length > 0) {
      await tx
        .update(waitlistOffer)
        .set({ status: "expired" })
        .where(
          and(
            inArray(
              waitlistOffer.entryId,
              lapsedEntries.map((e) => e.id),
            ),
            eq(waitlistOffer.status, "sent"),
          ),
        );
    }

    const reverted = await revertIdleEntries(tx, now);
    return lapsedOffers.length + lapsedEntries.length + reverted;
  });
}
