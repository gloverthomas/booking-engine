import { and, eq } from "drizzle-orm";
import { booking, client, payment, staff } from "@/db/schema";
import { createLogger } from "@/lib/logger";
import { recordAudit, type Actor } from "../audit";
import { DomainError } from "../booking/errors";
import type { CancelOutcome, ClientInput } from "../contracts";
import type { Db } from "../db-types";
import {
  assertCan,
  BOOKING_NOT_FOUND_MESSAGE,
  canAccessStaffMember,
  canMergeClients,
  NOT_ALLOWED_MESSAGE,
  staffScope,
  viewerCaps,
  type AccessContext,
} from "./access";
import { computeCheckout, type CheckoutAmounts, type ManualPaymentMethod } from "./checkout-math";
import type { AdminDomain } from "./domain";
import { AdminError, isOverlapError } from "./errors";
import { getBusinessContext, netPaidCents } from "./shared";

const log = createLogger("admin");

/** Everything a command needs. Tests pass a fake `domain`; actions pass the real one. */
export interface CommandContext {
  db: Db;
  actor: Actor;
  /** Who is acting. Every command checks their permission and, for stylists, that the booking is theirs. */
  access: AccessContext;
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

/**
 * The booking's stylist and status, or "not found" when it does not exist or belongs to another stylist
 * and the actor is a stylist. A stylist can therefore never tell someone else's booking from a missing one.
 */
async function loadAccessibleBooking(
  ctx: CommandContext,
  bookingId: string,
): Promise<{ staffId: string; status: typeof booking.$inferSelect.status; totalCents: number }> {
  const [row] = await ctx.db
    .select({ staffId: booking.staffId, status: booking.status, totalCents: booking.totalCents })
    .from(booking)
    .where(eq(booking.id, bookingId));
  if (!row || !canAccessStaffMember(ctx.access, row.staffId)) {
    throw new AdminError(BOOKING_NOT_FOUND_MESSAGE);
  }
  return row;
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
   * Whether the owner wants the client told. Passed to confirmBooking, which carries it on the
   * booking.confirmed event so the notifications module skips the client messages and reminder.
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
  assertCan(ctx.access, "booking.create");
  const scope = staffScope(ctx.access);
  let staffId = input.staffId;
  if (scope.kind === "own") {
    // A stylist books into their own column only.
    if (staffId && staffId !== scope.staffId) throw new AdminError(NOT_ALLOWED_MESSAGE);
    staffId = scope.staffId;
  }
  const { settings } = await getBusinessContext(ctx.db);
  const clientInput = await resolveClientInput(ctx.db, input);

  const hold = await ctx.domain.createHold(ctx.db, {
    locationId: input.locationId,
    staffId,
    serviceIds: input.serviceIds,
    start: input.start,
    client: clientInput,
    comments: input.comments,
    // Naming a person is a request for that person, so auto-balancing must not move it later.
    staffRequested: staffId !== undefined,
    policyVersion: settings.policyVersion,
    source: "admin",
    now: ctx.now,
  });

  try {
    await ctx.domain.confirmBooking(ctx.db, hold.bookingId, {
      notifyClient: input.notifyClient,
    });
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
    staffId: staffId ?? null,
  });
  return { bookingId: hold.bookingId };
}

/* Lifecycle --------------------------------------------------------------- */

export async function rescheduleStaffBooking(
  ctx: CommandContext,
  input: { bookingId: string; newStart: Date; notifyClient: boolean },
): Promise<void> {
  assertCan(ctx.access, "booking.edit");
  await loadAccessibleBooking(ctx, input.bookingId);
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
  assertCan(ctx.access, "booking.cancel");
  await loadAccessibleBooking(ctx, input.bookingId);
  const outcome = await ctx.domain.cancelBooking(ctx.db, {
    bookingId: input.bookingId,
    by: "staff",
    reason: input.reason,
    forceRefund: input.depositMode === "refund",
    keepDeposit: input.depositMode === "keep",
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
  assertCan(ctx.access, "booking.edit");
  await loadAccessibleBooking(ctx, input.bookingId);
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
  assertCan(ctx.access, "booking.edit");
  await loadAccessibleBooking(ctx, input.bookingId);
  await ctx.domain.resendConfirmation(ctx.db, input.bookingId);
  await audit(ctx, "booking.confirmation_resent", input.bookingId);
}

export async function refundBookingPayment(
  ctx: CommandContext,
  input: { bookingId: string; paymentId: string; amountCents?: number },
): Promise<void> {
  // Money going back out is the owner's call, whatever else a role may do to a booking.
  assertCan(ctx.access, "money.refund");
  await loadAccessibleBooking(ctx, input.bookingId);
  const [owned] = await ctx.db
    .select({ id: payment.id })
    .from(payment)
    .where(and(eq(payment.id, input.paymentId), eq(payment.bookingId, input.bookingId)));
  if (!owned) throw new AdminError("That payment was not found");
  await ctx.domain.refundPayment(ctx.db, input.paymentId, input.amountCents);
  await audit(ctx, "payment.refunded_by_staff", input.bookingId, {
    paymentId: input.paymentId,
    amountCents: input.amountCents ?? null,
  });
}

/**
 * Hand a booking to another stylist at the same time. Only roles that see everyone may do it. The domain
 * module checks that the new stylist is rostered, free and offers every service; its refusal reaches the
 * user as a plain sentence.
 */
export async function reassignStaffBooking(
  ctx: CommandContext,
  input: { bookingId: string; newStaffId: string; notifyClient: boolean },
): Promise<void> {
  if (!viewerCaps(ctx.access).reassign) throw new AdminError(NOT_ALLOWED_MESSAGE);
  const current = await loadAccessibleBooking(ctx, input.bookingId);
  if (current.staffId === input.newStaffId) {
    throw new AdminError("This booking is already with that stylist");
  }
  const [next] = await ctx.db
    .select({ name: staff.name, active: staff.active })
    .from(staff)
    .where(eq(staff.id, input.newStaffId));
  if (!next?.active) throw new AdminError("That stylist is not available");

  try {
    await ctx.domain.reassignBooking(ctx.db, {
      bookingId: input.bookingId,
      newStaffId: input.newStaffId,
      notifyClient: input.notifyClient,
      actor: ctx.actor,
      now: ctx.now,
    });
  } catch (error) {
    if (error instanceof AdminError) throw error;
    if (error instanceof DomainError) {
      throw new AdminError(`${next.name} cannot take this booking: ${error.message}`);
    }
    if (isOverlapError(error)) {
      throw new AdminError(`${next.name} is already busy at that time.`);
    }
    throw error;
  }
  await audit(ctx, "booking.stylist_changed", input.bookingId, {
    fromStaffId: current.staffId,
    toStaffId: input.newStaffId,
    notifyClient: input.notifyClient,
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
  assertCan(ctx.access, "checkout");
  const row = await loadAccessibleBooking(ctx, input.bookingId);
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
  if (!canMergeClients(ctx.access.role)) throw new AdminError(NOT_ALLOWED_MESSAGE);
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
