import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { client, waitlistEntry, waitlistOffer } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { localDate } from "../availability/engine";
import { loadStaffPlans, resolveServices, type StaffPlan } from "../availability/loader";
import { searchAvailability } from "../availability";
import { recordAudit } from "../audit";
import {
  BookingStateError,
  ClientBlockedError,
  DomainError,
  NotFoundError,
  SlotTakenError,
  ValidationError,
} from "../booking/errors";
import { isUuid } from "../booking/shared";
import type { WaitlistOfferInput } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import {
  ACTIVE_ENTRY_STATUSES,
  MINUTE_MS,
  actorForOffer,
  rangeStartsAt,
  type EntryRow,
} from "./shared";
import { windowAcceptsStart } from "./window";

const offerSchema = z.object({
  entryId: z.uuid(),
  staffId: z.uuid(),
  during: z
    .object({ start: z.date(), end: z.date() })
    .refine((d) => d.end.getTime() > d.start.getTime(), "The slot must end after it starts"),
  offeredBy: z.string().regex(/^(auto|owner:.+|staff:.+)$/, "Unknown offer source"),
});

/**
 * Offer one slot to one waitlist entry (the owner-override path, and what auto-offer uses). The slot
 * must be bookable for that entry's services right now, so a claim can succeed. The offer is held until
 * `settings.waitlistOfferWindowMin` from now, or the slot's start if that is sooner. Offering the same
 * entry the same slot twice returns the existing offer.
 */
export async function createWaitlistOffer(
  db: Db,
  input: WaitlistOfferInput,
): Promise<{ offerId: string }> {
  const parsed = offerSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid waitlist offer",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const { entryId, staffId, during, offeredBy } = parsed.data;
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(waitlistEntry)
      .where(eq(waitlistEntry.id, entryId))
      .for("update");
    if (!entry) throw new NotFoundError(`Waitlist entry not found: ${entryId}`);
    if (!ACTIVE_ENTRY_STATUSES.some((s) => s === entry.status)) {
      throw new BookingStateError(`This waitlist entry is ${entry.status}`, entry.status);
    }

    const [existing] = await tx
      .select({
        id: waitlistOffer.id,
        status: waitlistOffer.status,
        expiresAt: waitlistOffer.expiresAt,
      })
      .from(waitlistOffer)
      .where(
        and(
          eq(waitlistOffer.entryId, entryId),
          eq(waitlistOffer.staffId, staffId),
          inArray(waitlistOffer.status, ["sent", "claimed"]),
          rangeStartsAt(waitlistOffer.during, during.start),
        ),
      );
    if (
      existing &&
      (existing.status === "claimed" || existing.expiresAt.getTime() > now.getTime())
    ) {
      return { offerId: existing.id };
    }

    const [owner] = await tx.select().from(client).where(eq(client.id, entry.clientId));
    if (owner?.blocked) throw new ClientBlockedError();
    if (during.start.getTime() <= now.getTime()) {
      throw new ValidationError("That time has already passed");
    }
    if (offeredBy === "auto" && entry.staffId && entry.staffId !== staffId) {
      throw new ValidationError("This person asked for a different stylist");
    }

    const context = await getBusinessContext(tx, entry.locationId);
    const day = localDate(during.start, context.timezone);
    const search = await searchAvailability(tx, {
      locationId: entry.locationId,
      staffId,
      serviceIds: entry.serviceIds,
      fromDate: day,
      toDate: day,
      now,
    });
    if (!search.slots.some((s) => s.start.getTime() === during.start.getTime())) {
      throw new SlotTakenError("That time is not available for these services");
    }

    const windowEnd = now.getTime() + context.settings.waitlistOfferWindowMin * MINUTE_MS;
    const expiresAt = new Date(Math.min(windowEnd, during.start.getTime()));
    const [created] = await tx
      .insert(waitlistOffer)
      .values({
        entryId,
        staffId,
        locationId: entry.locationId,
        during,
        offeredBy,
        sentAt: now,
        expiresAt,
        createdAt: now,
      })
      .returning({ id: waitlistOffer.id });
    await tx
      .update(waitlistEntry)
      .set({ status: "offered", updatedAt: now })
      .where(eq(waitlistEntry.id, entryId));

    await emitDomainEvent(tx, { type: "waitlist.offer_created", offerId: created.id });
    await recordAudit(tx, {
      actor: actorForOffer(offeredBy),
      action: "waitlist.offer",
      entityType: "waitlist_offer",
      entityId: created.id,
      data: { entryId, staffId, start: during.start.toISOString(), offeredBy },
    });
    return { offerId: created.id };
  });
}

export interface FreedSlot {
  staffId: string;
  locationId: string;
  start: Date;
  end: Date;
  /** The client whose booking just freed the slot; they are not offered their own cancellation. */
  excludeClientId?: string;
}

/** The plan (price, duration) the stylist would use for an entry's services, or null when they cannot. */
async function planFor(
  db: Db,
  entry: EntryRow,
  staffId: string,
  cache: Map<string, StaffPlan | null>,
): Promise<StaffPlan | null> {
  const key = [...entry.serviceIds].sort().join(",");
  if (cache.has(key)) return cache.get(key) ?? null;
  const resolution = await resolveServices(db, entry.locationId, entry.serviceIds);
  const [plan] = resolution.ok ? await loadStaffPlans(db, resolution.services, staffId) : [];
  cache.set(key, plan ?? null);
  return plan ?? null;
}

/**
 * Auto-offer: a slot has freed up, so offer it to the oldest waiting entries it suits, up to
 * `settings.waitlistMaxOffersPerSlot` people at once (first to claim and pay wins). Does nothing when
 * auto-offer or the waitlist is off, when the slot is sooner than the minimum notice, or when enough
 * people already hold an open offer for it. Safe to call again for the same slot.
 */
export async function offerFreedSlot(
  db: Db,
  slot: FreedSlot,
  now: Date = new Date(),
): Promise<{ offerIds: string[] }> {
  if (!isUuid(slot.staffId) || !isUuid(slot.locationId)) return { offerIds: [] };
  const context = await getBusinessContext(db, slot.locationId);
  const { settings } = context;
  if (!settings.waitlistEnabled || !settings.waitlistAutoOffer) return { offerIds: [] };

  const startsInMs = slot.start.getTime() - now.getTime();
  if (startsInMs <= 0 || startsInMs < settings.minNoticeMin * MINUTE_MS) return { offerIds: [] };
  const rangeMin = (slot.end.getTime() - slot.start.getTime()) / MINUTE_MS;
  if (rangeMin <= 0) return { offerIds: [] };

  const forSlot = await db
    .select({
      entryId: waitlistOffer.entryId,
      status: waitlistOffer.status,
      expiresAt: waitlistOffer.expiresAt,
    })
    .from(waitlistOffer)
    .where(
      and(
        eq(waitlistOffer.staffId, slot.staffId),
        inArray(waitlistOffer.status, ["sent", "claimed"]),
        rangeStartsAt(waitlistOffer.during, slot.start),
      ),
    );
  const alreadyOffered = new Set(forSlot.map((o) => o.entryId));
  const open = forSlot.filter(
    (o) => o.status === "sent" && o.expiresAt.getTime() > now.getTime(),
  ).length;
  let remaining = settings.waitlistMaxOffersPerSlot - open;
  if (remaining <= 0) return { offerIds: [] };

  const candidates = await db
    .select()
    .from(waitlistEntry)
    .where(
      and(
        eq(waitlistEntry.locationId, slot.locationId),
        inArray(waitlistEntry.status, [...ACTIVE_ENTRY_STATUSES]),
        gt(waitlistEntry.expiresAt, now),
        slot.excludeClientId ? ne(waitlistEntry.clientId, slot.excludeClientId) : undefined,
      ),
    )
    .orderBy(asc(waitlistEntry.createdAt), asc(waitlistEntry.id));

  const plans = new Map<string, StaffPlan | null>();
  const offerIds: string[] = [];
  for (const entry of candidates) {
    if (remaining <= 0) break;
    if (alreadyOffered.has(entry.id)) continue;
    if (entry.staffId && entry.staffId !== slot.staffId) continue;
    if (!windowAcceptsStart(entry, slot.start, context.timezone)) continue;

    const plan = await planFor(db, entry, slot.staffId, plans);
    if (!plan || plan.durationMin + plan.bufferMin > rangeMin) continue;

    try {
      const { offerId } = await createWaitlistOffer(db, {
        entryId: entry.id,
        staffId: slot.staffId,
        during: {
          start: slot.start,
          end: new Date(slot.start.getTime() + plan.durationMin * MINUTE_MS),
        },
        offeredBy: "auto",
        now,
      });
      offerIds.push(offerId);
      remaining -= 1;
    } catch (error) {
      // This person cannot have the slot (blocked, not bookable for their services): try the next.
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return { offerIds };
}
