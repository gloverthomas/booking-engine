import { eq } from "drizzle-orm";
import { client, waitlistEntry, waitlistOffer } from "@/db/schema";
import { renderWaitlistOffer } from "@/emails";
import type { Db } from "../db-types";
import { makeManageToken } from "../manage-token";
import { getOfferView, type WaitlistOfferView } from "../waitlist/claim";
import { runAll, prepareSms, type Task } from "./deliver";
import { formatMoney, longDate, longTime, shortDate, shortTime } from "./format";
import { sendLogged, type LoggedSendResult } from "./message-log";
import { isE164 } from "./sms-text";
import { PermanentSendError, type NotificationDeps } from "./types";

const MINUTE_MS = 60_000;

export interface WaitlistOfferLinks {
  claimUrl: string;
  leaveUrl: string;
}

/** The claim link carries the offer token; the leave link carries the entry token. */
export function waitlistLinks(
  deps: NotificationDeps,
  offerId: string,
  entryId: string,
): WaitlistOfferLinks {
  const { appUrl, encryptionKey } = deps.config();
  return {
    claimUrl: `${appUrl}/waitlist/claim/${makeManageToken(offerId, encryptionKey)}`,
    leaveUrl: `${appUrl}/waitlist/leave/${makeManageToken(entryId, encryptionKey)}`,
  };
}

/** "Hi Sam, a time has opened up with Ryan: Mon, 2 Nov at 10:00AM at Northside. ..." */
export function smsWaitlistOffer(
  firstName: string,
  view: WaitlistOfferView,
  links: WaitlistOfferLinks,
  windowMin: number,
): string {
  const date = shortDate(view.start, view.timezone);
  const time = shortTime(view.start, view.timezone);
  return (
    `Hi ${firstName}, a time has opened up with ${view.staffName}: ${date} at ${time}, ${view.locationName}. ` +
    `${formatMoney(view.depositCents)} deposit secures it. First to pay gets it, held ${windowMin} min: ${links.claimUrl} ` +
    `Leave the waitlist: ${links.leaveUrl}`
  );
}

/**
 * Tells a waitlist person a time has opened up, by email and SMS, with a claim link and a leave link.
 * Idempotent per offer: the message_log dedupe key is the offer id, so event replays and job retries
 * never message twice. Nothing is sent once the offer is claimed, taken, withdrawn or past its window.
 * W7 calls this from the event handler on waitlist.offer_created.
 */
export async function notifyWaitlistOffer(
  db: Db,
  offerId: string,
  deps: NotificationDeps,
): Promise<LoggedSendResult[]> {
  const { encryptionKey } = deps.config();
  const now = deps.now();
  const view = await getOfferView(db, makeManageToken(offerId, encryptionKey), now, {
    encryptionKey,
  });
  if (!view) {
    deps.log({ event: "waitlist_offer_notification_skipped_missing", offerId });
    return [];
  }
  if (view.status !== "sent") {
    deps.log({ event: "waitlist_offer_notification_skipped", offerId, status: view.status });
    return [];
  }

  const [row] = await db
    .select({ client })
    .from(waitlistOffer)
    .innerJoin(waitlistEntry, eq(waitlistEntry.id, waitlistOffer.entryId))
    .innerJoin(client, eq(client.id, waitlistEntry.clientId))
    .where(eq(waitlistOffer.id, offerId));
  if (!row) return [];
  const person = row.client;

  const links = waitlistLinks(deps, offerId, view.entryId);
  const windowMin = Math.max(1, Math.round((view.expiresAt.getTime() - now.getTime()) / MINUTE_MS));
  const dedupeBase = `waitlist-offer:${offerId}`;
  const tasks: Task[] = [];

  const address = person.email;
  if (address) {
    tasks.push(() =>
      sendLogged(
        db,
        {
          clientId: person.id,
          channel: "email",
          template: "waitlist_offer",
          toAddress: address,
          dedupeKey: `${dedupeBase}:email`,
          send: async () => {
            const rendered = await renderWaitlistOffer({
              businessName: view.businessName,
              firstName: person.firstName,
              staffName: view.staffName,
              dateLabel: longDate(view.start, view.timezone),
              timeLabel: longTime(view.start, view.timezone),
              services: view.services.map((s) => ({
                name: s.name,
                price: formatMoney(s.priceCents),
              })),
              totalLabel: formatMoney(view.totalCents),
              locationName: view.locationName,
              address: view.locationAddress ?? "",
              depositLabel: formatMoney(view.depositCents),
              windowLabel: `${windowMin} minutes`,
              heldUntilLabel: longTime(view.expiresAt, view.timezone),
              ...links,
            });
            return deps.email().send({
              to: [address],
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
            });
          },
        },
        deps.log,
        deps.now,
      ),
    );
  } else {
    deps.log({ event: "email_skipped_no_email", offerId, template: "waitlist_offer" });
  }

  const phone = person.phone;
  if (phone) {
    tasks.push(() =>
      sendLogged(
        db,
        {
          clientId: person.id,
          channel: "sms",
          template: "waitlist_offer",
          toAddress: phone,
          dedupeKey: `${dedupeBase}:sms`,
          send: async () => {
            if (!isE164(phone)) throw new PermanentSendError(`Phone number is not E.164: ${phone}`);
            const body = smsWaitlistOffer(person.firstName, view, links, windowMin);
            return deps.sms().send({ to: phone, body: prepareSms(body, deps) });
          },
        },
        deps.log,
        deps.now,
      ),
    );
  } else {
    deps.log({ event: "sms_skipped_no_phone", offerId, template: "waitlist_offer" });
  }

  return runAll(tasks);
}
