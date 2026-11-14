import { and, eq } from "drizzle-orm";
import { webhookEvent } from "@/db/schema";
import type { Db } from "@/server/db-types";

/**
 * Claim-then-complete idempotency on top of `webhook_event` (unique on provider + event id).
 *
 * `claimOnce` returns true when the caller should do the work: either nobody has claimed the
 * key yet, or an earlier attempt claimed it but never finished (processedAt still null).
 * Call `markProcessed` after the work succeeded.
 */
export async function claimOnce(db: Db, provider: string, eventId: string): Promise<boolean> {
  const inserted = await db
    .insert(webhookEvent)
    .values({ provider, eventId })
    .onConflictDoNothing()
    .returning({ id: webhookEvent.id });
  if (inserted.length > 0) return true;

  const [existing] = await db
    .select({ processedAt: webhookEvent.processedAt })
    .from(webhookEvent)
    .where(and(eq(webhookEvent.provider, provider), eq(webhookEvent.eventId, eventId)));
  return existing?.processedAt == null;
}

export async function markProcessed(
  db: Db,
  provider: string,
  eventId: string,
  now: Date,
): Promise<void> {
  await db
    .update(webhookEvent)
    .set({ processedAt: now })
    .where(and(eq(webhookEvent.provider, provider), eq(webhookEvent.eventId, eventId)));
}
