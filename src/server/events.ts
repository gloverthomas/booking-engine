import { isNull, asc, inArray } from "drizzle-orm";
import { domainEvent } from "@/db/schema";
import type { Db } from "./db-types";

/** Everything other modules may react to. Add new members here; consumers ignore types they don't care about. */
export type DomainEvent =
  | {
      type: "booking.confirmed";
      bookingId: string;
      /** False for staff-created bookings where the owner chose not to tell the client. Default true. */
      notifyClient?: boolean;
    }
  | {
      type: "booking.cancelled";
      bookingId: string;
      by: "client" | "staff";
      depositAction: "refund" | "keep" | "none";
      /** Extra fee to charge the saved card; 0 when none. */
      feeCents: number;
    }
  | { type: "booking.rescheduled"; bookingId: string; previousStart: string; notifyClient: boolean }
  | { type: "booking.completed"; bookingId: string }
  | { type: "booking.no_show"; bookingId: string; feeCents: number }
  | { type: "payment.succeeded"; paymentId: string }
  | { type: "payment.refunded"; paymentId: string }
  | { type: "client.updated"; clientId: string }
  | { type: "waitlist.entry_joined"; entryId: string }
  | { type: "waitlist.offer_created"; offerId: string }
  | { type: "waitlist.offer_claimed"; offerId: string; bookingId: string };

/** Queues that receive every event. Each consumer handler ignores the types it does not handle. */
export const EVENT_CONSUMERS = [
  "consumer.waitlist",
  "consumer.payments",
  "consumer.notifications",
  "consumer.google",
  "consumer.xero",
] as const;

/** Write inside the same transaction as the state change (transactional outbox). */
export async function emitDomainEvent(db: Db, event: DomainEvent): Promise<void> {
  const { type, ...payload } = event;
  await db.insert(domainEvent).values({ type, payload });
}

export type Publish = (queue: string, data: Record<string, unknown>) => Promise<void>;

/** Fan unprocessed events out to every consumer queue, then mark them processed. Returns the count. */
export async function relayDomainEvents(db: Db, publish: Publish, limit = 100): Promise<number> {
  return db.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(domainEvent)
      .where(isNull(domainEvent.processedAt))
      .orderBy(asc(domainEvent.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    for (const event of events) {
      for (const queue of EVENT_CONSUMERS) {
        await publish(queue, { eventId: event.id, type: event.type, ...event.payload });
      }
    }
    if (events.length > 0) {
      await tx
        .update(domainEvent)
        .set({ processedAt: new Date() })
        .where(
          inArray(
            domainEvent.id,
            events.map((e) => e.id),
          ),
        );
    }
    return events.length;
  });
}
