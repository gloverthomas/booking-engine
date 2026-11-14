import { eq } from "drizzle-orm";
import { messageLog } from "@/db/schema";
import type { LogFn } from "@/lib/logger";
import type { Db } from "../db-types";
import { PermanentSendError, type SendResult } from "./types";

export interface LoggedSendInput {
  bookingId?: string | null;
  clientId?: string | null;
  channel: "email" | "sms";
  template: string;
  toAddress: string;
  /**
   * Unique per logical message, e.g. `<bookingId>:confirmation:sms`. A message that is already
   * sent is never sent again, so event replays and job retries cannot double send. Null means
   * "always send" (one-off admin messages).
   */
  dedupeKey: string | null;
  /** Does the actual delivery. Only called when the message has not already been sent. */
  send: () => Promise<SendResult>;
}

export type LoggedSendResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "duplicate" }
  | { status: "failed"; error: string };

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** Insert the queued row, or find the existing one for this dedupe key. */
async function claimRow(
  db: Db,
  input: LoggedSendInput,
): Promise<{ id: string; alreadySent: boolean }> {
  const inserted = await db
    .insert(messageLog)
    .values({
      bookingId: input.bookingId ?? null,
      clientId: input.clientId ?? null,
      channel: input.channel,
      template: input.template,
      toAddress: input.toAddress,
      dedupeKey: input.dedupeKey,
      status: "queued",
    })
    .onConflictDoNothing({ target: messageLog.dedupeKey })
    .returning({ id: messageLog.id });
  if (inserted[0]) return { id: inserted[0].id, alreadySent: false };

  if (!input.dedupeKey) throw new Error("message_log insert returned no row");
  const [existing] = await db
    .select({ id: messageLog.id, status: messageLog.status })
    .from(messageLog)
    .where(eq(messageLog.dedupeKey, input.dedupeKey));
  if (!existing) throw new Error(`message_log row vanished for ${input.dedupeKey}`);
  return {
    id: existing.id,
    alreadySent: existing.status === "sent" || existing.status === "delivered",
  };
}

/**
 * Write a `queued` row first, then deliver, then record the outcome. A permanent failure is
 * returned (and logged in the table); a transient one is recorded and rethrown so the queue retries.
 */
export async function sendLogged(
  db: Db,
  input: LoggedSendInput,
  log: LogFn,
  now: () => Date,
): Promise<LoggedSendResult> {
  const row = await claimRow(db, input);
  if (row.alreadySent) {
    log({ event: "message_duplicate_skipped", dedupeKey: input.dedupeKey });
    return { status: "duplicate" };
  }

  try {
    const result = await input.send();
    await db
      .update(messageLog)
      .set({
        status: "sent",
        providerMessageId: result.providerMessageId,
        sentAt: now(),
        error: null,
        toAddress: input.toAddress,
      })
      .where(eq(messageLog.id, row.id));
    return { status: "sent", providerMessageId: result.providerMessageId };
  } catch (error: unknown) {
    const message = describe(error);
    await db
      .update(messageLog)
      .set({ status: "failed", error: message })
      .where(eq(messageLog.id, row.id));
    log({
      event: "message_failed",
      channel: input.channel,
      template: input.template,
      error: message,
    });
    if (error instanceof PermanentSendError) return { status: "failed", error: message };
    throw error;
  }
}
