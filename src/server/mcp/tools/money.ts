import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { booking, client, payment } from "@/db/schema";
import { defineWrite, type ToolContext } from "../deps";
import { McpToolError, callBackend } from "../errors";
import { moneySpentToday, startOfBusinessDay } from "../guards";
import { centsSchema, dollars, idSchema, whenOut } from "../shared";
import { personName, quoted, untrusted } from "../text";

const REFUNDABLE_KINDS = ["deposit", "balance", "no_show_fee", "late_cancel_fee"];
const REFUNDABLE_STATUSES = ["succeeded", "partially_refunded"];

/** The operator's kill switch. Checked first, so a disabled tool reveals nothing about bookings or payments. */
function assertMoneyEnabled(ctx: ToolContext): void {
  if (!ctx.deps.config.moneyToolsEnabled) {
    throw new McpToolError(
      "money_tools_disabled",
      "Refunds and fees through Claude are switched off. They can only be enabled by the person who runs the server (MCP_MONEY_TOOLS_ENABLED).",
    );
  }
}

/** Per-call and daily caps. Runs on both steps; the daily cap is enforced again, atomically, at execute time. */
export async function assertMoneyAllowed(
  ctx: ToolContext,
  amountCents: number,
): Promise<{ spentTodayCents: number; remainingTodayCents: number }> {
  const { config } = ctx.deps;
  assertMoneyEnabled(ctx);
  if (amountCents > config.maxMoneyCentsPerCall) {
    throw new McpToolError(
      "amount_exceeds_per_call_cap",
      `${dollars(amountCents)} is over the per-call limit of ${dollars(config.maxMoneyCentsPerCall)}. Do it in the admin instead.`,
      { perCallCapCents: config.maxMoneyCentsPerCall },
    );
  }
  const spent = await moneySpentToday(
    ctx.deps.db,
    startOfBusinessDay(ctx.deps.now(), ctx.timezone),
  );
  const remaining = Math.max(0, config.maxMoneyCentsPerDay - spent);
  if (amountCents > remaining) {
    throw new McpToolError(
      "daily_cap_exceeded",
      `${dollars(amountCents)} would exceed today's MCP money allowance (${dollars(remaining)} left of ${dollars(config.maxMoneyCentsPerDay)}).`,
      { spentTodayCents: spent, dailyCapCents: config.maxMoneyCentsPerDay },
    );
  }
  return { spentTodayCents: spent, remainingTodayCents: remaining };
}

/* ------------------------------- refund_payment ----------------------------- */

const refundSchema = z.object({
  paymentId: idSchema,
  amountCents: centsSchema
    .optional()
    .describe("Part of the payment to refund, in cents. Omit to refund all of it."),
});

async function loadRefundTarget(ctx: ToolContext, paymentId: string) {
  const [row] = await ctx.deps.db
    .select({
      p: payment,
      bookingId: booking.id,
      start: booking.during,
      clientId: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
    })
    .from(payment)
    .leftJoin(booking, eq(booking.id, payment.bookingId))
    .leftJoin(client, eq(client.id, booking.clientId))
    .where(eq(payment.id, paymentId));
  if (!row) throw new McpToolError("not_found", "No payment with that id.");
  if (!REFUNDABLE_KINDS.includes(row.p.kind)) {
    throw new McpToolError(
      "precondition_failed",
      "Only deposits, balances and fees can be refunded.",
    );
  }
  if (!REFUNDABLE_STATUSES.includes(row.p.status)) {
    throw new McpToolError(
      "precondition_failed",
      `That payment is ${row.p.status}, so it cannot be refunded.`,
    );
  }
  return row;
}

export const refundPaymentTool = defineWrite({
  kind: "money",
  name: "refund_payment",
  title: "Refund a payment",
  description:
    "Refund all or part of a payment to the original card. MONEY TOOL: off unless the server operator enables it, " +
    "capped per call and per day, and always previewed with the exact amount and recipient before anything moves.",
  schema: refundSchema,
  destructive: true,
  entityType: "payment",
  auditArgs: (a) => ({ amountCents: a.amountCents }),
  async prepare(args, ctx) {
    assertMoneyEnabled(ctx);
    const row = await loadRefundTarget(ctx, args.paymentId);
    const amount = args.amountCents ?? row.p.amountCents;
    if (amount > row.p.amountCents) {
      throw new McpToolError(
        "invalid_input",
        `The payment was only ${dollars(row.p.amountCents)}; it cannot be refunded more than that.`,
      );
    }
    const allowance = await assertMoneyAllowed(ctx, amount);
    const name = row.firstName
      ? personName(row.firstName, row.lastName ?? "")
      : "(no client linked)";
    return {
      moneyCents: amount,
      summary:
        `REFUND ${dollars(amount)} of a ${dollars(row.p.amountCents)} ${row.p.kind.replace(/_/g, " ")} ` +
        `paid by ${quoted(name)} (${row.p.method.replace(/_/g, " ")}) back to the original payment method. ` +
        `This cannot be undone from here. Allowance left today after this: ${dollars(allowance.remainingTodayCents - amount)}.`,
      details: {
        paymentId: row.p.id,
        bookingId: row.bookingId,
        client: row.clientId ? { id: row.clientId, name: untrusted(name, 120) } : null,
        paymentKind: row.p.kind,
        paymentAmountCents: row.p.amountCents,
        refundAmountCents: amount,
        paidAt: whenOut(row.p.createdAt, ctx.timezone),
        ...allowance,
      },
    };
  },
  async execute(args, ctx, preview) {
    const amount = preview.moneyCents ?? args.amountCents;
    await callBackend(() => ctx.deps.services.refundPayment(ctx.deps.db, args.paymentId, amount));
    return {
      summary: `Refunded ${dollars(amount ?? 0)}.`,
      entityId: args.paymentId,
      audit: { amountCents: amount },
      result: { paymentId: args.paymentId, refundedCents: amount },
    };
  },
});

/* ----------------------------- charge_no_show_fee --------------------------- */

const feeSchema = z.object({
  bookingId: idSchema,
  amountCents: centsSchema,
  kind: z
    .enum(["no_show_fee", "late_cancel_fee"])
    .default("no_show_fee")
    .describe("no_show_fee for a no-show booking, late_cancel_fee for a late cancellation."),
});

const FEE_FOR_STATUS = { no_show_fee: "no_show", late_cancel_fee: "late_cancelled" } as const;

export const chargeFeeTool = defineWrite({
  kind: "money",
  name: "charge_no_show_fee",
  title: "Charge a no-show or late-cancel fee",
  description:
    "Charge the client's saved card an extra fee for a no-show or late cancellation (on top of the kept deposit). " +
    "MONEY TOOL: off unless the server operator enables it, capped per call and per day, previewed with the exact " +
    "amount and client first. Only works on bookings already marked no-show or late-cancelled.",
  schema: feeSchema,
  destructive: true,
  entityType: "booking",
  auditArgs: (a) => ({ amountCents: a.amountCents, kind: a.kind }),
  async prepare(args, ctx) {
    assertMoneyEnabled(ctx);
    const [row] = await ctx.deps.db
      .select({
        b: booking,
        clientId: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        stripeCustomerId: client.stripeCustomerId,
      })
      .from(booking)
      .innerJoin(client, eq(client.id, booking.clientId))
      .where(eq(booking.id, args.bookingId));
    if (!row) throw new McpToolError("not_found", "No booking with that id.");
    const required = FEE_FOR_STATUS[args.kind];
    if (row.b.status !== required) {
      throw new McpToolError(
        "precondition_failed",
        `A ${args.kind.replace(/_/g, " ")} needs a booking marked ${required.replace("_", "-")}; this one is ${row.b.status}.`,
      );
    }
    if (!row.stripeCustomerId) {
      throw new McpToolError(
        "precondition_failed",
        "This client has no saved card, so there is nothing to charge.",
      );
    }
    const [already] = await ctx.deps.db
      .select({ id: payment.id })
      .from(payment)
      .where(
        and(
          eq(payment.bookingId, args.bookingId),
          inArray(payment.kind, ["no_show_fee", "late_cancel_fee"]),
          inArray(payment.status, ["pending", "succeeded", "partially_refunded"]),
        ),
      )
      .limit(1);
    if (already) {
      throw new McpToolError(
        "precondition_failed",
        "A fee has already been charged (or is pending) for this booking.",
      );
    }
    const allowance = await assertMoneyAllowed(ctx, args.amountCents);
    const name = personName(row.firstName, row.lastName);
    return {
      moneyCents: args.amountCents,
      summary:
        `CHARGE ${dollars(args.amountCents)} ${args.kind.replace(/_/g, " ")} to ${quoted(name)}'s saved card ` +
        `for the booking on ${whenOut(row.b.during.start, ctx.timezone).local}. ` +
        `The deposit is already kept; this is an extra charge. The bank may ask the client to authenticate.`,
      details: {
        bookingId: row.b.id,
        client: { id: row.clientId, name: untrusted(name, 120) },
        feeKind: args.kind,
        amountCents: args.amountCents,
        bookingStatus: row.b.status,
        ...allowance,
      },
    };
  },
  async execute(args, ctx) {
    await callBackend(() =>
      ctx.deps.services.chargeSavedCard(ctx.deps.db, {
        bookingId: args.bookingId,
        kind: args.kind,
        amountCents: args.amountCents,
      }),
    );
    return {
      summary: `Charged ${dollars(args.amountCents)}.`,
      entityId: args.bookingId,
      audit: { amountCents: args.amountCents },
      result: { bookingId: args.bookingId, kind: args.kind, chargedCents: args.amountCents },
    };
  },
});
