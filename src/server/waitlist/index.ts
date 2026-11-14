import type {
  HoldResult,
  WaitlistJoinInput,
  WaitlistOfferInput,
  WaitlistOfferSummary,
} from "../contracts";
import type { Db } from "../db-types";

/** OWNER: workstream W6 (waitlist). Replace these stubs; keep the signatures (optional trailing params allowed). */

export async function joinWaitlist(
  _db: Db,
  _input: WaitlistJoinInput,
): Promise<{ entryId: string }> {
  throw new Error("joinWaitlist not implemented");
}

/** Client or staff removes an entry. Idempotent. */
export async function cancelWaitlistEntry(
  _db: Db,
  _entryId: string,
  _by: "client" | "staff",
): Promise<void> {
  throw new Error("cancelWaitlistEntry not implemented");
}

/** Create an offer for one entry (the owner-override path, and what auto-offer uses). Emits waitlist.offer_created. */
export async function createWaitlistOffer(
  _db: Db,
  _input: WaitlistOfferInput,
): Promise<{ offerId: string }> {
  throw new Error("createWaitlistOffer not implemented");
}

/** Auto-offer: find waiting entries that match a freed slot and offer it to up to the configured number. */
export async function offerFreedSlot(
  _db: Db,
  _slot: { staffId: string; locationId: string; start: Date; end: Date },
  _now?: Date,
): Promise<{ offerIds: string[] }> {
  throw new Error("offerFreedSlot not implemented");
}

export async function getOfferByToken(
  _db: Db,
  _token: string,
  _now?: Date,
): Promise<WaitlistOfferSummary | null> {
  throw new Error("getOfferByToken not implemented");
}

/** Claim an offer: creates the held booking (first one wins). Throws SlotTakenError-like when it is gone. */
export async function claimOffer(_db: Db, _token: string, _now?: Date): Promise<HoldResult> {
  throw new Error("claimOffer not implemented");
}

/** Mark offers past their window and entries past their last date as expired. Returns how many changed. */
export async function expireWaitlist(_db: Db, _now?: Date): Promise<number> {
  throw new Error("expireWaitlist not implemented");
}
