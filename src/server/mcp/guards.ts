import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { auditLog } from "@/db/schema";
import type { Db } from "../db-types";
import { recordAudit } from "../audit";
import { McpToolError } from "./errors";

const CONSUMED = "mcp.confirm.consumed";
const RESERVE = "mcp.money.reserve";
const RELEASE = "mcp.money.release";

/**
 * Make a confirm token single use. Recorded in the audit log, so it survives restarts and works across server
 * instances, and serialised with an advisory lock so two simultaneous replays cannot both win.
 */
export async function consumeConfirmToken(db: Db, tokenId: string, tool: string): Promise<void> {
  const fresh = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mcp-token:${tokenId}`}))`);
    const [existing] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, CONSUMED), eq(auditLog.entityId, tokenId)))
      .limit(1);
    if (existing) return false;
    await recordAudit(tx, {
      actor: "mcp",
      action: CONSUMED,
      entityType: "mcp_confirm",
      entityId: tokenId,
      data: { tool },
    });
    return true;
  });
  if (!fresh) {
    throw new McpToolError(
      "confirm_token_used",
      "That confirmation was already used. Nothing further was done. Ask for a new preview if you want to repeat it.",
    );
  }
}

/** Instant of local midnight today in the business timezone: the start of the daily money window. */
export function startOfBusinessDay(now: Date, timezone: string): Date {
  return DateTime.fromJSDate(now, { zone: timezone }).startOf("day").toJSDate();
}

const spentExpr = sql<number>`coalesce(sum(case when ${auditLog.action} = ${RESERVE} then (${auditLog.data}->>'amountCents')::int else -(${auditLog.data}->>'amountCents')::int end), 0)::int`;

/** Cents already moved (or reserved) by MCP money tools since the start of the business day. */
export async function moneySpentToday(db: Db, dayStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: spentExpr })
    .from(auditLog)
    .where(and(inArray(auditLog.action, [RESERVE, RELEASE]), gte(auditLog.at, dayStart)));
  return row?.total ?? 0;
}

/**
 * Reserve part of today's allowance before moving money. Done under an advisory lock so concurrent confirmations
 * cannot overshoot the cap. Returns the reservation id; release it if the money did not move.
 */
export async function reserveDailyMoney(
  db: Db,
  input: {
    amountCents: number;
    capCents: number;
    dayStart: Date;
    /** Stamped on the reservation so the daily window follows the injected clock. */
    now: Date;
    tool: string;
    entityId?: string;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mcp-money-daily'))`);
    const [row] = await tx
      .select({ total: spentExpr })
      .from(auditLog)
      .where(and(inArray(auditLog.action, [RESERVE, RELEASE]), gte(auditLog.at, input.dayStart)));
    const spent = row?.total ?? 0;
    if (spent + input.amountCents > input.capCents) {
      throw new McpToolError(
        "daily_cap_exceeded",
        `That would take today's MCP money total past the daily cap. Already used: ${spent} cents; cap: ${input.capCents} cents.`,
        { spentTodayCents: spent, dailyCapCents: input.capCents },
      );
    }
    const [reserved] = await tx
      .insert(auditLog)
      .values({
        actor: "mcp",
        action: RESERVE,
        entityType: "mcp_money",
        entityId: input.entityId,
        data: { amountCents: input.amountCents, tool: input.tool },
        at: input.now,
      })
      .returning({ id: auditLog.id });
    return reserved.id;
  });
}

/** Give back a reservation when the money movement failed. */
export async function releaseDailyMoney(
  db: Db,
  input: { reservationId: string; amountCents: number; tool: string; now: Date },
): Promise<void> {
  await db.insert(auditLog).values({
    actor: "mcp",
    action: RELEASE,
    entityType: "mcp_money",
    entityId: input.reservationId,
    data: { amountCents: input.amountCents, tool: input.tool },
    at: input.now,
  });
}
