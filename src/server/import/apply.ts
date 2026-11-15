import { eq } from "drizzle-orm";
import { booking, bookingService, client, payment } from "@/db/schema";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { TIMELY_SOURCE } from "./constants";
import type { BookingOp, ClientOp, ClientTarget, ClientValues, ImportIssue } from "./types";

export interface ApplyResult {
  created: number;
  linked: number;
  failed: number;
  issues: ImportIssue[];
}

const emptyResult = (): ApplyResult => ({ created: 0, linked: 0, failed: 0, issues: [] });

function clientRow(values: ClientValues, externalRef: string | null) {
  return {
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email,
    phone: values.phone,
    notes: values.notes,
    marketingOptIn: values.marketingOptIn,
    blocked: values.blocked,
    externalRef,
    ...(values.createdAt ? { createdAt: values.createdAt } : {}),
  };
}

/** One transaction per row: a bad row is reported and the rest carry on. */
export async function applyClients(
  db: Db,
  ops: readonly ClientOp[],
  businessId?: string,
): Promise<ApplyResult> {
  const result = emptyResult();
  for (const op of ops) {
    if (op.action === "skip" || op.action === "unchanged") continue;
    try {
      await db.transaction(async (tx) => {
        if (op.action === "create") {
          await tx.insert(client).values({ ...clientRow(op.values, op.externalRef), businessId });
          return;
        }
        const [existing] = await tx
          .select()
          .from(client)
          .where(eq(client.id, op.existingId ?? ""));
        if (!existing) throw new Error("Matching client disappeared during the import");
        await tx
          .update(client)
          .set({
            externalRef: op.externalRef,
            email: existing.email ?? op.values.email,
            phone: existing.phone ?? op.values.phone,
          })
          .where(eq(client.id, existing.id));
      });
      if (op.action === "create") result.created += 1;
      else result.linked += 1;
    } catch (e) {
      result.failed += 1;
      result.issues.push({ row: op.row, level: "error", message: describeFailure(e) });
    }
  }
  return result;
}

export interface BookingApplyOptions {
  sendReminders: boolean;
  now: Date;
  businessId?: string;
}

type LegacyPayment = { kind: "deposit" | "balance"; amountCents: number; note: string };

function legacyPayments(op: BookingOp): LegacyPayment[] {
  const list: LegacyPayment[] = [];
  if (op.depositCents > 0) {
    list.push({
      kind: "deposit",
      amountCents: op.depositCents,
      note: "Deposit taken before the move from the previous system",
    });
  }
  if (op.balanceCents > 0) {
    list.push({
      kind: "balance",
      amountCents: op.balanceCents,
      note: "Balance recorded when importing a completed appointment",
    });
  }
  return list;
}

export async function applyBookings(
  db: Db,
  ops: readonly BookingOp[],
  options: BookingApplyOptions,
): Promise<ApplyResult> {
  const result = emptyResult();
  /** Clients created for earlier rows of this run, so a person with two appointments is one client. */
  const newClients = new Map<string, string>();

  for (const op of ops) {
    if (op.action !== "create") continue;
    const createdClientKeys: string[] = [];
    try {
      await db.transaction(async (tx) => {
        const clientId = await resolveClientId(
          tx,
          op.client,
          newClients,
          createdClientKeys,
          options.businessId,
        );
        const [created] = await tx
          .insert(booking)
          .values({
            staffId: op.staffId,
            locationId: op.locationId,
            clientId,
            status: op.status,
            during: { start: op.start, end: op.end },
            totalCents: op.totalCents,
            depositCents: op.depositCents,
            comments: op.notes,
            source: TIMELY_SOURCE,
            externalRef: op.externalRef,
            ...(op.status === "cancelled_by_staff"
              ? { cancelledAt: options.now, cancelReason: "Imported as cancelled" }
              : {}),
          })
          .returning({ id: booking.id });

        await tx.insert(bookingService).values(
          op.lines.map((line, position) => ({
            bookingId: created.id,
            serviceId: line.serviceId,
            name: line.name,
            durationMin: line.durationMin,
            priceCents: line.priceCents,
            position,
          })),
        );

        const payments = legacyPayments(op);
        if (payments.length > 0) {
          await tx.insert(payment).values(
            payments.map((p) => ({
              bookingId: created.id,
              kind: p.kind,
              method: "other" as const,
              status: "succeeded" as const,
              amountCents: p.amountCents,
              note: p.note,
              metadata: { legacy: true, importedFrom: op.externalRef },
            })),
          );
        }

        if (options.sendReminders && op.status === "confirmed" && op.start > options.now) {
          await emitDomainEvent(tx, { type: "booking.imported", bookingId: created.id });
        }
      });
      result.created += 1;
    } catch (e) {
      for (const key of createdClientKeys) newClients.delete(key);
      result.failed += 1;
      result.issues.push({ row: op.row, level: "error", message: describeFailure(e) });
    }
  }
  return result;
}

/**
 * Create the client on first use. The key is only remembered once the booking commits, so a rolled-back
 * row never leaves a dangling id for later rows to reuse.
 */
async function resolveClientId(
  tx: Db,
  target: ClientTarget,
  remembered: Map<string, string>,
  createdKeys: string[],
  businessId?: string,
): Promise<string> {
  if (target.kind === "existing") return target.id;
  const known = remembered.get(target.key);
  if (known) return known;
  const [row] = await tx
    .insert(client)
    .values({ ...clientRow(target.values, target.externalRef), businessId })
    .returning({ id: client.id });
  createdKeys.push(target.key);
  remembered.set(target.key, row.id);
  return row.id;
}

/** Drizzle wraps the Postgres error as `cause`; the constraint that fired is on the inner one. */
function failureText(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") parts.push(constraint);
    current = current.cause;
  }
  return parts.join(" | ");
}

function describeFailure(e: unknown): string {
  const text = failureText(e);
  if (/no_overlap|exclusion/i.test(text)) return "Overlaps another booking for this stylist";
  if (/external_ref_uidx|duplicate key/i.test(text)) return "Already imported";
  return e instanceof Error ? e.message : "Unexpected error";
}
