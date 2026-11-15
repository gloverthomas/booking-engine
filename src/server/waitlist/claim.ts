import { asc, eq } from "drizzle-orm";
import {
  booking,
  bookingService,
  business,
  client,
  location,
  staff,
  waitlistEntry,
  waitlistOffer,
} from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { loadStaffPlans, resolveServices } from "../availability/loader";
import { recordAudit } from "../audit";
import {
  NotFoundError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
} from "../booking/errors";
import { createHold } from "../booking";
import { isUuid } from "../booking/shared";
import type { HoldResult, WaitlistOfferSummary } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { makeManageToken, verifyManageToken } from "../manage-token";
import { depositFor } from "../pricing";
import { OfferGoneError } from "./errors";
import { MINUTE_MS, resolveKey, type OfferRow, type WaitlistOptions } from "./shared";

/** What the claim page shows: the summary plus everything needed to render and to accept the policy. */
export interface WaitlistOfferView extends WaitlistOfferSummary {
  timezone: string;
  businessName: string;
  staffName: string;
  locationAddress: string | null;
  totalCents: number;
  policy: { version: string; text: string; cancelWindowHours: number; depositPct: number };
  /** Status of the booking made by claiming (null before a claim). */
  bookingStatus: string | null;
  /** The claimed booking's manage token (null before a claim). */
  manageToken: string | null;
  /** True when this offer was claimed and its payment can still be completed. */
  resumable: boolean;
}

function formatAddress(row: typeof location.$inferSelect): string | null {
  const region = [row.state, row.postcode].filter(Boolean).join(" ");
  const text = [row.addressLine, [row.suburb, region].filter(Boolean).join(" ")]
    .filter((part) => part && part.length > 0)
    .join(", ");
  return text || null;
}

function openOfferId(token: string, options: WaitlistOptions): string | null {
  const id = verifyManageToken(token, resolveKey(options));
  return id && isUuid(id) ? id : null;
}

/**
 * Everything about an offer for its link holder, or null when the token is not authentic or the offer
 * is gone. `status` is "expired" once the window has passed even before the hourly sweep marks it.
 */
export async function getOfferView(
  db: Db,
  token: string,
  now: Date = new Date(),
  options: WaitlistOptions = {},
): Promise<WaitlistOfferView | null> {
  const offerId = openOfferId(token, options);
  if (!offerId) return null;

  const [row] = await db
    .select({ offer: waitlistOffer, entry: waitlistEntry, location, staffName: staff.name })
    .from(waitlistOffer)
    .innerJoin(waitlistEntry, eq(waitlistEntry.id, waitlistOffer.entryId))
    .innerJoin(location, eq(location.id, waitlistOffer.locationId))
    .innerJoin(staff, eq(staff.id, waitlistOffer.staffId))
    .where(eq(waitlistOffer.id, offerId));
  if (!row) return null;

  const { offer, entry } = row;
  const context = await getBusinessContext(db, offer.locationId);
  const { settings } = context;
  const [biz] = await db
    .select({ name: business.name })
    .from(business)
    .where(eq(business.id, context.businessId));

  const resolution = await resolveServices(db, offer.locationId, entry.serviceIds);
  const services = resolution.ok ? resolution.services : [];
  const [plan] = resolution.ok ? await loadStaffPlans(db, services, offer.staffId) : [];
  const lines = plan
    ? plan.lines.map((l) => ({
        name: l.service.name,
        priceCents: l.priceCents,
        depositPct: l.service.depositPct,
      }))
    : services.map((s) => ({ name: s.name, priceCents: s.priceCents, depositPct: s.depositPct }));
  const totalCents = lines.reduce((sum, l) => sum + l.priceCents, 0);
  const depositCents = depositFor(lines, settings.depositPct);

  let bookingStatus: string | null = null;
  let resumable = false;
  if (offer.claimedBookingId) {
    const [claimed] = await db
      .select({ status: booking.status, holdExpiresAt: booking.holdExpiresAt })
      .from(booking)
      .where(eq(booking.id, offer.claimedBookingId));
    bookingStatus = claimed?.status ?? null;
    resumable =
      claimed?.status === "pending_payment" &&
      claimed.holdExpiresAt !== null &&
      claimed.holdExpiresAt.getTime() > now.getTime();
  }

  const lapsed = offer.status === "sent" && offer.expiresAt.getTime() <= now.getTime();
  return {
    offerId: offer.id,
    entryId: offer.entryId,
    start: offer.during.start,
    end: offer.during.end,
    locationName: row.location.name,
    services: lines.map((l) => ({ name: l.name, priceCents: l.priceCents })),
    depositCents,
    expiresAt: offer.expiresAt,
    status: lapsed ? "expired" : offer.status,
    timezone: context.timezone,
    businessName: biz?.name ?? row.staffName,
    staffName: row.staffName,
    locationAddress: formatAddress(row.location),
    totalCents,
    policy: {
      version: settings.policyVersion,
      text: settings.policyText,
      cancelWindowHours: settings.cancelWindowHours,
      depositPct: settings.depositPct,
    },
    bookingStatus,
    manageToken: offer.claimedBookingId
      ? makeManageToken(offer.claimedBookingId, resolveKey(options))
      : null,
    resumable,
  };
}

/** The offer a link points at, or null when the link is not valid. */
export async function getOfferByToken(
  db: Db,
  token: string,
  now: Date = new Date(),
  options: WaitlistOptions = {},
): Promise<WaitlistOfferSummary | null> {
  const view = await getOfferView(db, token, now, options);
  if (!view) return null;
  return {
    offerId: view.offerId,
    entryId: view.entryId,
    start: view.start,
    end: view.end,
    locationName: view.locationName,
    services: view.services,
    depositCents: view.depositCents,
    expiresAt: view.expiresAt,
    status: view.status,
  };
}

export interface ClaimOptions extends WaitlistOptions {
  /** The policy version the person ticked. Must equal the business's current policyVersion. */
  policyVersion?: string;
}

type ClaimOutcome =
  | { kind: "claimed"; hold: HoldResult }
  | { kind: "gone"; reason: ConstructorParameters<typeof OfferGoneError>[0] }
  | { kind: "taken" };

/** Rebuild the hold a claimed offer already made, so a refresh or retry resumes the same payment. */
async function resumeHold(
  db: Db,
  offer: OfferRow,
  now: Date,
  options: WaitlistOptions,
): Promise<HoldResult | null> {
  if (!offer.claimedBookingId) return null;
  const [row] = await db.select().from(booking).where(eq(booking.id, offer.claimedBookingId));
  if (!row || row.status !== "pending_payment") return null;
  if (!row.holdExpiresAt || row.holdExpiresAt.getTime() <= now.getTime()) return null;
  const services = await db
    .select({ durationMin: bookingService.durationMin })
    .from(bookingService)
    .where(eq(bookingService.bookingId, row.id))
    .orderBy(asc(bookingService.position));
  const minutes = services.reduce((sum, s) => sum + s.durationMin, 0);
  return {
    bookingId: row.id,
    manageToken: makeManageToken(row.id, resolveKey(options)),
    holdExpiresAt: row.holdExpiresAt,
    totalCents: row.totalCents,
    depositCents: row.depositCents,
    during: {
      start: row.during.start,
      end:
        minutes > 0 ? new Date(row.during.start.getTime() + minutes * MINUTE_MS) : row.during.end,
    },
  };
}

/**
 * Claim an offered slot: creates the held booking (source "waitlist", stylist requested) and moves the
 * offer to "claimed"; the caller then collects the deposit. First to claim wins: the booking exclusion
 * constraint lets exactly one claimer in, and the others' offers become "slot_taken" with a friendly
 * error. Claiming again while the hold is alive resumes it instead of failing.
 */
export async function claimOffer(
  db: Db,
  token: string,
  now: Date = new Date(),
  options: ClaimOptions = {},
): Promise<HoldResult> {
  const offerId = openOfferId(token, options);
  if (!offerId) throw new NotFoundError("This waitlist link is not valid");
  if (!options.policyVersion) {
    throw new ValidationError("The cancellation policy must be accepted");
  }
  const policyVersion = options.policyVersion;

  const outcome = await db.transaction(async (tx): Promise<ClaimOutcome> => {
    const [found] = await tx
      .select()
      .from(waitlistOffer)
      .where(eq(waitlistOffer.id, offerId))
      .for("update");
    if (!found) throw new NotFoundError("This waitlist link is not valid");
    const offer = found;

    if (offer.status === "claimed") {
      const resumed = await resumeHold(tx, offer, now, options);
      return resumed ? { kind: "claimed", hold: resumed } : { kind: "gone", reason: "claimed" };
    }
    if (offer.status === "slot_taken") return { kind: "taken" };
    if (offer.status === "cancelled") return { kind: "gone", reason: "cancelled" };
    if (offer.status === "expired" || offer.expiresAt.getTime() <= now.getTime()) {
      if (offer.status === "sent") {
        await tx
          .update(waitlistOffer)
          .set({ status: "expired" })
          .where(eq(waitlistOffer.id, offer.id));
      }
      return { kind: "gone", reason: "expired" };
    }

    const [entry] = await tx
      .select()
      .from(waitlistEntry)
      .where(eq(waitlistEntry.id, offer.entryId))
      .for("update");
    const [owner] = entry
      ? await tx.select().from(client).where(eq(client.id, entry.clientId))
      : [undefined];
    if (!entry || !owner || !owner.phone) return { kind: "gone", reason: "cancelled" };
    if (entry.status !== "waiting" && entry.status !== "offered") {
      return { kind: "gone", reason: "cancelled" };
    }

    const context = await getBusinessContext(tx, offer.locationId);
    if (policyVersion !== context.settings.policyVersion) {
      throw new PolicyVersionError(context.settings.policyVersion, policyVersion);
    }

    let hold: HoldResult;
    try {
      hold = await createHold(
        tx,
        {
          locationId: offer.locationId,
          staffId: offer.staffId,
          serviceIds: entry.serviceIds,
          start: offer.during.start,
          client: {
            firstName: owner.firstName,
            lastName: owner.lastName,
            email: owner.email ?? undefined,
            phone: owner.phone,
          },
          policyVersion,
          source: "waitlist",
          staffRequested: true,
          now,
        },
        { encryptionKey: resolveKey(options) },
      );
    } catch (error) {
      if (!(error instanceof SlotTakenError)) throw error;
      await tx
        .update(waitlistOffer)
        .set({ status: "slot_taken" })
        .where(eq(waitlistOffer.id, offer.id));
      await recordAudit(tx, {
        actor: "client",
        action: "waitlist.slot_taken",
        entityType: "waitlist_offer",
        entityId: offer.id,
      });
      return { kind: "taken" };
    }

    await tx
      .update(waitlistOffer)
      .set({ status: "claimed", claimedBookingId: hold.bookingId })
      .where(eq(waitlistOffer.id, offer.id));
    await emitDomainEvent(tx, {
      type: "waitlist.offer_claimed",
      offerId: offer.id,
      bookingId: hold.bookingId,
    });
    await recordAudit(tx, {
      actor: "client",
      action: "waitlist.claim",
      entityType: "waitlist_offer",
      entityId: offer.id,
      data: { bookingId: hold.bookingId },
    });
    return { kind: "claimed", hold };
  });

  if (outcome.kind === "claimed") return outcome.hold;
  if (outcome.kind === "taken") {
    throw new SlotTakenError(
      "Sorry, someone else claimed this time first. We'll keep you on the waitlist for the next one.",
    );
  }
  throw new OfferGoneError(outcome.reason);
}

export interface BillingDetails {
  name: string;
  email: string;
  phone: string;
}

/** Who is paying for a held booking, for Stripe's billing details. Empty strings when unknown. */
export async function loadBillingDetails(db: Db, bookingId: string): Promise<BillingDetails> {
  const [row] = await db
    .select({
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
    })
    .from(booking)
    .innerJoin(client, eq(client.id, booking.clientId))
    .where(eq(booking.id, bookingId));
  if (!row) throw new NotFoundError(`Booking not found: ${bookingId}`);
  return {
    name: `${row.firstName} ${row.lastName}`.trim(),
    email: row.email ?? "",
    phone: row.phone ?? "",
  };
}
