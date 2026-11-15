import { z } from "zod";
import type { Actor } from "../audit";
import type { Db } from "../db-types";
import { cancelWaitlistEntry } from "./join";
import { createWaitlistOffer } from "./offers";

export const removeEntrySchema = z.object({ entryId: z.uuid() });

export const offerSlotSchema = z.object({
  entryId: z.uuid(),
  staffId: z.uuid(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});

/** Staff removes a waitlist entry. Withdraws its open offers. Audited as the signed-in person. */
export async function removeEntry(db: Db, raw: unknown, actor: Actor): Promise<void> {
  const { entryId } = removeEntrySchema.parse(raw);
  await cancelWaitlistEntry(db, entryId, "staff", { actor });
}

/**
 * The owner (or staff) offers a specific slot to an entry, overriding auto-offer. The offer is attributed
 * to `actor` ("owner:<id>" or "staff:<id>"), and the person is messaged by the usual event pipeline.
 */
export async function offerSlot(
  db: Db,
  raw: unknown,
  actor: Extract<Actor, `owner:${string}` | `staff:${string}`>,
  now?: Date,
): Promise<{ offerId: string }> {
  const input = offerSlotSchema.parse(raw);
  return createWaitlistOffer(db, {
    entryId: input.entryId,
    staffId: input.staffId,
    during: { start: new Date(input.start), end: new Date(input.end) },
    offeredBy: actor,
    now,
  });
}
