import { eq } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import { recordAudit, type Actor } from "../audit";
import type { CancelOutcome, ClientInput } from "../contracts";
import type { Db } from "../db-types";
import { computeCheckout, type CheckoutAmounts, type ManualPaymentMethod } from "./checkout-math";
import type { AdminDomain } from "./domain";
import { AdminError } from "./errors";
import { getBusinessContext, netPaidCents } from "./shared";

const log = createLogger("admin");

/** Everything a command needs. Tests pass a fake `domain`; actions pass the real one. */
export interface CommandContext {
  db: Db;
  actor: Actor;
  domain: AdminDomain;
  now?: Date;
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

async function audit(
  ctx: CommandContext,
  action: string,
  bookingId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await recordAudit(ctx.db, {
    actor: ctx.actor,
    action,
    entityType: "booking",
    entityId: bookingId,
    data,
  });
}

/* Create ------------------------------------------------------------------ */

export interface NewClientDetails {
  firstName: string;
  lastName: string;
  /** E.164. */
  phone: string;
  email: string;
}

export interface CreateStaffBookingInput {
  locationId: string;
  staffId?: string;
  serviceIds: string[];
  start: Date;
  client: { existingClientId: string } | { newClient: NewClientDetails };
  comments?: string;
  /**
   * Whether the owner wants the client told. Recorded in the audit trail; sending is decided by the
   * notifications module (see report: confirmBooking has no notify flag yet).
   */
  notifyClient: boolean;
}

async function resolveClientInput(db: Db, input: CreateStaffBookingInput): Promise<ClientInput> {
  if ("newClient" in input.client) {
    const c = input.client.newClient;
    return { firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone };
  }
  const [row] = await db.select().from(client).where(eq(client.id, input.client.existingClientId));
  if (!row) throw new AdminError("That client was not found");
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? "",
    phone: row.phone ?? "",
    pronouns: row.pronouns ?? undefined,
    marketingOptIn: row.marketingOptIn,
  };
}

/** Staff-created booking: hold the slot, then confirm straight away (no deposit is taken from staff bookings). */
export async function createStaffBooking(
  ctx: CommandContext,
  input: CreateStaffBookingInput,
): Promise<{ bookingId: string }> {
  const { settings } = await getBusinessContext(ctx.db);
  const clientInput = await resolveClientInput(ctx.db, input);

  const hold = await ctx.domain.createHold(ctx.db, {
    locationId: input.locationId,
    staffId: input.staffId,
    serviceIds: input.serviceIds,
    start: input.start,
    client: clientInput,
    comments: input.comments,
    policyVersion: settings.policyVersion,
    source: "admin",
    now: ctx.now,
  });

  try {
    await ctx.domain.confirmBooking(ctx.db, hold.bookingId);
  } catch (error) {
    // Free the slot so an immediate retry does not collide with our own hold.
    try {
      await ctx.domain.cancelBooking(ctx.db, {
        bookingId: hold.bookingId,
        by: "staff",
        reason: "Could not be confirmed",
        now: ctx.now,
      });
    } catch (cleanupError) {
      log({
        level: "error",
        msg: "failed to release hold after confirm error",
        bookingId: hold.bookingId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }

  await audit(ctx, "booking.created_by_staff", hold.bookingId, {
    notifyClient: input.notifyClient,
    start: input.start.toISOString(),
    serviceIds: input.serviceIds,
    locationId: input.locationId,
  });
  return { bookingId: hold.bookingId };
}

/* Lifecycle --------------------------------------------------------------- */

export async function rescheduleStaffBooking(
  ctx: CommandContext,
  input: { bookingId: string; newStart: Date; notifyClient: boolean },
): Promise<void> {
  await ctx.domain.rescheduleBooking(ctx.db, {
    bookingId: input.bookingId,
    newStart: input.newStart,
    by: "staff",
    notifyClient: input.notifyClient,
  });
  await audit(ctx, "booking.rescheduled_by_staff", input.bookingId, {
    newStart: input.newStart.toISOString(),
    notifyClient: input.notifyClient,
  });
}

export async function cancelStaffBooking(
  ctx: CommandContext,
  input: { bookingId: string; depositMode: "refund" | "keep"; reason?: string },
): Promise<CancelOutcome> {
  const outcome = await ctx.domain.cancelBooking(ctx.db, {
    bookingId: input.bookingId,
    by: "staff",
    reason: input.reason,
    forceRefund: input.depositMode === "refund",
  });
  await audit(ctx, "booking.cancelled_by_staff", input.bookingId, {
    depositMode: input.depositMode,
    depositAction: outcome.depositAction,
    feeCents: outcome.feeCents,
    reason: input.reason ?? null,
  });
  return outcome;
}

export async function markBookingNoShow(
  ctx: CommandContext,
  input: { bookingId: string },
): Promise<CancelOutcome> {
  const outcome = await ctx.domain.markNoShow(ctx.db, input.bookingId);
  await audit(ctx, "booking.no_show", input.bookingId, {
    depositAction: outcome.depositAction,
    feeCents: outcome.feeCents,
  });
  return outcome;
}

export async function resendBookingConfirmation(
  ctx: CommandContext,
  input: { bookingId: string },
): Promise<void> {
  await ctx.domain.resendConfirmation(ctx.db, input.bookingId);
  await audit(ctx, "booking.confirmation_resent", input.bookingId);
}

export async function refundBookingPayment(
  ctx: CommandContext,
  input: { bookingId: string; paymentId: string; amountCents?: number },
): Promise<void> {
  await ctx.domain.refundPayment(ctx.db, input.paymentId, input.amountCents);
  await audit(ctx, "payment.refunded_by_staff", input.bookingId, {
    paymentId: input.paymentId,
    amountCents: input.amountCents ?? null,
  });
}

/* Checkout ---------------------------------------------------------------- */

export interface CheckoutResult extends CheckoutAmounts {
  method: ManualPaymentMethod;
  /** False when nothing was owed or the balance had already been recorded by an earlier attempt. */
  recordedPayment: boolean;
}

const NOT_CHECKOUT_MESSAGES: Record<string, string> = {
  pending_payment: "This booking has not been confirmed yet",
  completed: "This booking is already completed",
  no_show: "This booking was marked as a no-show",
  cancelled_by_client: "This booking was cancelled",
  cancelled_by_staff: "This booking was cancelled",
  late_cancelled: "This booking was cancelled",
  expired: "This booking expired",
};

/**
 * Record the balance (with the cash discount for cash) and close the booking. Safe to retry: a balance
 * payment that already exists is never recorded twice.
 */
export async function checkoutBooking(
  ctx: CommandContext,
  input: { bookingId: string; method: ManualPaymentMethod },
): Promise<CheckoutResult> {
  const [row] = await ctx.db
    .select({ status: booking.status, totalCents: booking.totalCents })
    .from(booking)
    .where(eq(booking.id, input.bookingId));
  if (!row) throw new AdminError("That booking was not found");
  if (row.status !== "confirmed") {
    throw new AdminError(NOT_CHECKOUT_MESSAGES[row.status] ?? "This booking cannot be checked out");
  }

  const [payments, { settings }] = await Promise.all([
    ctx.db.select().from(payment).where(eq(payment.bookingId, input.bookingId)),
    getBusinessContext(ctx.db),
  ]);
  const amounts = computeCheckout(
    { totalCents: row.totalCents, paidCents: netPaidCents(payments) },
    settings,
    input.method,
  );
  const alreadyRecorded = payments.some((p) => p.kind === "balance" && p.status === "succeeded");

  const shouldRecord = !alreadyRecorded && amounts.payableCents > 0;
  if (shouldRecord) {
    await ctx.domain.recordManualPayment(ctx.db, {
      bookingId: input.bookingId,
      method: input.method,
      amountCents: amounts.payableCents,
      note:
        amounts.cashDiscountCents > 0
          ? `Cash discount ${settings.cashDiscountPct}% (-${money(amounts.cashDiscountCents)})`
          : undefined,
    });
  }
  await ctx.domain.completeBooking(ctx.db, input.bookingId);

  await audit(ctx, "booking.checked_out", input.bookingId, {
    method: input.method,
    totalCents: amounts.totalCents,
    payableCents: shouldRecord ? amounts.payableCents : 0,
    cashDiscountCents: amounts.cashDiscountCents,
  });
  return { ...amounts, method: input.method, recordedPayment: shouldRecord };
}

/* Clients ----------------------------------------------------------------- */

export async function mergeClientRecords(
  ctx: CommandContext,
  input: { keepClientId: string; duplicateClientId: string },
): Promise<void> {
  if (input.keepClientId === input.duplicateClientId) {
    throw new AdminError("A client cannot be merged into itself");
  }
  await ctx.domain.mergeClients(ctx.db, input.keepClientId, input.duplicateClientId);
  await recordAudit(ctx.db, {
    actor: ctx.actor,
    action: "client.merged",
    entityType: "client",
    entityId: input.keepClientId,
    data: { duplicateClientId: input.duplicateClientId },
  });
}
