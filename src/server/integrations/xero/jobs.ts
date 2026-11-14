import { and, eq, gt, inArray, isNotNull, isNull, like, ne, sql } from "drizzle-orm";
import { booking, payment, webhookEvent } from "@/db/schema";
import { getAccount, stateString } from "../common/account-store";
import { errorMessage, NotConnectedError } from "../common/errors";
import {
  handleXeroDomainEvent,
  reportXeroFailure,
  retryInvoiceEmail,
  type XeroConsumerDeps,
} from "./consumer";
import { getXeroAccessToken } from "./runtime";

export const XERO_JOBS = {
  consumer: "consumer.xero",
  keepalive: "xero.keepalive",
  reconcile: "xero.reconcile",
} as const;

export const XERO_SCHEDULES = {
  keepalive: "41 3 * * *",
  reconcile: "37 * * * *",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Refresh tokens last 60 days unused; refreshing weekly keeps a quiet business connected. */
const KEEPALIVE_AFTER_MS = 7 * DAY_MS;
/** Reconcile only looks at recent work, and only a few items per run, to protect the 1,000 calls/day budget. */
const RECONCILE_WINDOW_MS = 14 * DAY_MS;
const RECONCILE_BATCH = 5;

/**
 * Refresh the token if it has not been refreshed for a week. Xero refresh tokens expire after 60
 * days of non-use, and a quiet spell would otherwise silently disconnect the integration.
 * Token refreshes are not API calls and do not count against the daily limit.
 */
export async function runXeroKeepalive(deps: XeroConsumerDeps): Promise<boolean> {
  const account = await getAccount(deps.db, "xero");
  if (!account || account.status !== "connected") return false;
  const last = stateString(account.syncState, "lastTokenRefreshAt");
  if (last && deps.now().getTime() - new Date(last).getTime() < KEEPALIVE_AFTER_MS) return false;
  try {
    await getXeroAccessToken(deps, { force: true });
    return true;
  } catch (error) {
    if (!(error instanceof NotConnectedError)) await reportXeroFailure(deps, error);
    return false;
  }
}

async function replay(deps: XeroConsumerDeps, event: Parameters<typeof handleXeroDomainEvent>[1]) {
  try {
    await handleXeroDomainEvent(deps, event);
  } catch (error) {
    // Failures are already recorded on the account; the next run tries again.
    deps.log({ event: "xero_reconcile_item_failed", message: errorMessage(error) });
  }
}

/**
 * Backstop for work the queue gave up on or that was blocked on configuration: replays recent
 * bookings without an invoice, succeeded payments not yet in Xero, refunds not yet booked, and
 * invoice emails that failed to send. Every replay is idempotent. Returns the items replayed.
 */
export async function runXeroReconcile(deps: XeroConsumerDeps): Promise<number> {
  const account = await getAccount(deps.db, "xero");
  if (!account || account.status !== "connected") return 0;
  const since = new Date(deps.now().getTime() - RECONCILE_WINDOW_MS);
  let replayed = 0;

  const bookings = await deps.db
    .select({ id: booking.id })
    .from(booking)
    .where(
      and(
        inArray(booking.status, ["confirmed", "completed"]),
        isNull(booking.xeroInvoiceId),
        ne(booking.totalCents, 0),
        gt(booking.createdAt, since),
      ),
    )
    .limit(RECONCILE_BATCH);
  for (const row of bookings) {
    await replay(deps, { type: "booking.confirmed", bookingId: row.id });
    replayed += 1;
  }

  const payments = await deps.db
    .select({ id: payment.id, kind: payment.kind })
    .from(payment)
    .innerJoin(booking, eq(booking.id, payment.bookingId))
    .where(
      and(
        isNull(payment.xeroPaymentId),
        isNotNull(payment.bookingId),
        gt(payment.createdAt, since),
        sql`${payment.status} in ('succeeded','partially_refunded','refunded')`,
        // Payments for bookings with no invoice are handled by the booking replay above.
        sql`(${payment.kind} in ('no_show_fee','late_cancel_fee','refund') or ${booking.xeroInvoiceId} is not null)`,
      ),
    )
    .limit(RECONCILE_BATCH);
  for (const row of payments) {
    await replay(deps, {
      type: row.kind === "refund" ? "payment.refunded" : "payment.succeeded",
      paymentId: row.id,
    });
    replayed += 1;
  }

  const pendingEmails = await deps.db
    .select({ eventId: webhookEvent.eventId })
    .from(webhookEvent)
    .where(
      and(
        eq(webhookEvent.provider, "xero"),
        like(webhookEvent.eventId, "invoice-email:%"),
        isNull(webhookEvent.processedAt),
        gt(webhookEvent.receivedAt, since),
      ),
    )
    .limit(RECONCILE_BATCH);
  for (const row of pendingEmails) {
    await retryInvoiceEmail(deps, row.eventId.slice("invoice-email:".length));
    replayed += 1;
  }
  return replayed;
}
