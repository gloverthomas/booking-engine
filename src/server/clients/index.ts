import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import { booking, client, messageLog } from "@/db/schema";
import { recordAudit, type Actor } from "../audit";
import { ClientMergeError, NotFoundError, ValidationError } from "../booking/errors";
import type { ClientInput } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";

export type ClientRecord = typeof client.$inferSelect;

const DEFAULT_COUNTRY = "AU";
const MAX_MERGE_HOPS = 10;

/** E.164 for a valid number (Australian by default), otherwise null. */
export function normalizePhone(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_COUNTRY);
  return parsed?.isValid() ? parsed.number : null;
}

/** Lower-cased, trimmed email, or null when it does not look like one. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return z.email().safeParse(email).success ? email : null;
}

const clientInput = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().max(100).default(""),
  pronouns: z.string().trim().max(50).optional(),
  marketingOptIn: z.boolean().optional(),
});

interface NormalisedClient {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
  pronouns?: string;
  marketingOptIn?: boolean;
}

function normaliseInput(input: ClientInput): NormalisedClient {
  const issues: string[] = [];
  const parsed = clientInput.safeParse(input);
  if (!parsed.success)
    issues.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const provided = Boolean(input.email?.trim());
  const email = provided ? normalizeEmail(input.email ?? "") : null;
  if (provided && !email) issues.push("email: Enter a valid email address");
  const phone = normalizePhone(input.phone);
  if (!phone) issues.push("phone: Enter a valid mobile number");
  if (!parsed.success || (provided && !email) || !phone)
    throw new ValidationError("Invalid client details", issues);
  return { ...parsed.data, email, phone };
}

/** Follow mergedIntoId to the surviving client. Cycle- and depth-safe; a dangling pointer stops the walk. */
async function resolveSurvivor(db: Db, start: ClientRecord): Promise<ClientRecord> {
  const seen = new Set<string>([start.id]);
  let current = start;
  for (let hop = 0; hop < MAX_MERGE_HOPS && current.mergedIntoId; hop += 1) {
    if (seen.has(current.mergedIntoId)) break;
    const [next] = await db.select().from(client).where(eq(client.id, current.mergedIntoId));
    if (!next) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/** Prefer a live (unmerged) match; otherwise follow the first merged match to its survivor. */
async function pickMatch(db: Db, rows: ClientRecord[]): Promise<ClientRecord | null> {
  if (rows.length === 0) return null;
  const live = rows.find((row) => row.mergedIntoId === null);
  return live ?? resolveSurvivor(db, rows[0]);
}

async function findMatch(
  db: Db,
  email: string | null,
  phone: string,
): Promise<ClientRecord | null> {
  if (email) {
    const byEmail = await db
      .select()
      .from(client)
      .where(eq(sql`lower(${client.email})`, email))
      .orderBy(client.createdAt);
    const emailMatch = await pickMatch(db, byEmail);
    if (emailMatch) return emailMatch;
  }

  const byPhone = await db
    .select()
    .from(client)
    .where(eq(client.phone, phone))
    .orderBy(client.createdAt);
  return pickMatch(db, byPhone);
}

/**
 * Find the client for a booking (email first, then phone) or create one. Name, pronouns and the
 * marketing choice are updated; existing contact details are never overwritten (so typing someone
 * else's email cannot redirect their SMS) and notes are never touched.
 */
export async function findOrCreateClient(
  db: Db,
  input: ClientInput,
  businessId?: string,
): Promise<ClientRecord> {
  const details = normaliseInput(input);

  return db.transaction(async (tx) => {
    const existing = await findMatch(tx, details.email, details.phone);

    if (!existing) {
      const [created] = await tx
        .insert(client)
        .values({
          businessId,
          firstName: details.firstName,
          lastName: details.lastName,
          email: details.email,
          phone: details.phone,
          pronouns: details.pronouns,
          marketingOptIn: details.marketingOptIn ?? false,
        })
        .returning();
      await emitDomainEvent(tx, { type: "client.updated", clientId: created.id });
      return created;
    }

    const changes: Partial<typeof client.$inferInsert> = {};
    if (existing.firstName !== details.firstName) changes.firstName = details.firstName;
    if (existing.lastName !== details.lastName) changes.lastName = details.lastName;
    if (details.pronouns !== undefined && existing.pronouns !== details.pronouns) {
      changes.pronouns = details.pronouns;
    }
    if (
      details.marketingOptIn !== undefined &&
      existing.marketingOptIn !== details.marketingOptIn
    ) {
      changes.marketingOptIn = details.marketingOptIn;
    }
    if (!existing.email && details.email) changes.email = details.email;
    if (!existing.phone) changes.phone = details.phone;
    if (Object.keys(changes).length === 0) return existing;

    const [updated] = await tx
      .update(client)
      .set(changes)
      .where(eq(client.id, existing.id))
      .returning();
    await emitDomainEvent(tx, { type: "client.updated", clientId: updated.id });
    return updated;
  });
}

function joinNotes(target: string | null, source: string | null): string | null {
  const parts = [target, source].filter((n): n is string => Boolean(n && n.trim()));
  return parts.length === 0 ? null : parts.join("\n\n");
}

/**
 * Fold duplicate client `fromId` into `toId`: bookings and message history move across, gaps in the
 * target are filled from the source, VIP/blocked flags are OR-ed, and the source is marked merged.
 */
export async function mergeClients(
  db: Db,
  fromId: string,
  toId: string,
  actor: Actor = "system",
): Promise<void> {
  if (fromId === toId) throw new ClientMergeError("Cannot merge a client into themselves");

  await db.transaction(async (tx) => {
    const [from] = await tx.select().from(client).where(eq(client.id, fromId)).for("update");
    const [to] = await tx.select().from(client).where(eq(client.id, toId)).for("update");
    if (!from) throw new NotFoundError(`Client not found: ${fromId}`);
    if (!to) throw new NotFoundError(`Client not found: ${toId}`);
    if (from.mergedIntoId) throw new ClientMergeError("That client has already been merged");
    if (to.mergedIntoId) {
      throw new ClientMergeError(
        "The target client has itself been merged; merge into the survivor",
      );
    }

    await tx.update(booking).set({ clientId: toId }).where(eq(booking.clientId, fromId));
    await tx.update(messageLog).set({ clientId: toId }).where(eq(messageLog.clientId, fromId));

    await tx
      .update(client)
      .set({
        email: to.email ?? from.email,
        phone: to.phone ?? from.phone,
        pronouns: to.pronouns ?? from.pronouns,
        stripeCustomerId: to.stripeCustomerId ?? from.stripeCustomerId,
        xeroContactId: to.xeroContactId ?? from.xeroContactId,
        notes: joinNotes(to.notes, from.notes),
        isVip: to.isVip || from.isVip,
        blocked: to.blocked || from.blocked,
        marketingOptIn: to.marketingOptIn || from.marketingOptIn,
      })
      .where(eq(client.id, toId));
    await tx
      .update(client)
      .set({ mergedIntoId: toId })
      .where(and(eq(client.id, fromId), isNull(client.mergedIntoId)));

    await emitDomainEvent(tx, { type: "client.updated", clientId: toId });
    await recordAudit(tx, {
      actor,
      action: "client.merge",
      entityType: "client",
      entityId: toId,
      data: { fromId },
    });
  });
}
