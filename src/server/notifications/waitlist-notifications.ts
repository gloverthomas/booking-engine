import type { Db } from "../db-types";
import type { LoggedSendResult } from "./message-log";
import type { NotificationDeps } from "./types";

/**
 * OWNER: workstream W6 (waitlist). Sends the "a time has opened up" email and SMS for one offer, with a
 * claim link. Idempotent per offer. W7 calls it from the notifications event handler on
 * waitlist.offer_created. Replace the stub; keep the signature.
 */
export async function notifyWaitlistOffer(
  _db: Db,
  _offerId: string,
  _deps: NotificationDeps,
): Promise<LoggedSendResult[]> {
  throw new Error("notifyWaitlistOffer not implemented");
}
