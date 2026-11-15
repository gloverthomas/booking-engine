import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { waitlistEntry, waitlistOffer } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { localDate } from "../availability/engine";
import { loadStaffPlans, resolveServices } from "../availability/loader";
import { recordAudit, type Actor } from "../audit";
import {
  ClientBlockedError,
  NotFoundError,
  ValidationError,
  VipOnlyError,
} from "../booking/errors";
import { isUuid } from "../booking/shared";
import { findOrCreateClient } from "../clients";
import type { WaitlistJoinInput } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import { WaitlistDisabledError } from "./errors";
import { ACTIVE_ENTRY_STATUSES, type EntryRow } from "./shared";
import { MINUTES_PER_DAY } from "./window";

/** Stops one person (or a script) piling up entries. */
export const MAX_ACTIVE_ENTRIES_PER_CLIENT = 10;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD")
  .refine((value) => DateTime.fromISO(value).isValid, "Not a real calendar date");

const minute = z
  .number()
  .int()
  .min(0)
  .max(MINUTES_PER_DAY - 1);

const joinSchema = z.object({
  locationId: z.uuid(),
  staffId: z.uuid().optional(),
  serviceIds: z.array(z.uuid()).min(1, "Select at least one service").max(10),
  earliestDate: isoDate,
  latestDate: isoDate,
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  fromMinute: minute.optional(),
  toMinute: minute.optional(),
  notes: z.string().trim().max(500).optional(),
});

interface NormalisedWindow {
  weekdays: number[] | null;
  fromMinute: number | null;
  toMinute: number | null;
}

/** All seven days is "any day"; the full day is "any time". Sorted and de-duplicated. */
function normaliseWindow(input: z.infer<typeof joinSchema>): NormalisedWindow {
  const days = [...new Set(input.weekdays ?? [])].sort((a, b) => a - b);
  const weekdays = days.length === 0 || days.length === 7 ? null : days;

  if (input.fromMinute === undefined && input.toMinute === undefined) {
    return { weekdays, fromMinute: null, toMinute: null };
  }
  const fromMinute = input.fromMinute ?? 0;
  const toMinute = input.toMinute ?? MINUTES_PER_DAY - 1;
  if (fromMinute > toMinute) {
    throw new ValidationError("The earliest time must not be after the latest time");
  }
  if (fromMinute === 0 && toMinute === MINUTES_PER_DAY - 1) {
    return { weekdays, fromMinute: null, toMinute: null };
  }
  return { weekdays, fromMinute, toMinute };
}

function entryKey(entry: {
  staffId: string | null;
  serviceIds: string[];
  earliestDate: string;
  latestDate: string;
  weekdays: number[] | null;
  fromMinute: number | null;
  toMinute: number | null;
}): string {
  return JSON.stringify([
    entry.staffId,
    [...entry.serviceIds].sort(),
    entry.earliestDate,
    entry.latestDate,
    entry.weekdays ? [...entry.weekdays].sort((a, b) => a - b) : null,
    entry.fromMinute,
    entry.toMinute,
  ]);
}

/**
 * Put a client on the waitlist. Checks everything the booking flow would (services offered here, the
 * stylist offers them all, VIP-only and blocked clients, the booking horizon) so offers made later can
 * actually be claimed. An identical active entry is returned instead of duplicated.
 */
export async function joinWaitlist(db: Db, input: WaitlistJoinInput): Promise<{ entryId: string }> {
  const parsed = joinSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid waitlist request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const data = parsed.data;
  const now = input.now ?? new Date();
  const window = normaliseWindow(data);
  if (data.earliestDate > data.latestDate) {
    throw new ValidationError("The first date must not be after the last date");
  }
  const serviceIds = [...new Set(data.serviceIds)];

  return db.transaction(async (tx) => {
    const context = await getBusinessContext(tx, data.locationId);
    if (!context.settings.waitlistEnabled) throw new WaitlistDisabledError();
    if (!context.locationActive) throw new ValidationError("That location is not taking bookings");

    const today = localDate(now, context.timezone);
    const horizon = DateTime.fromISO(today, { zone: context.timezone })
      .plus({ days: context.settings.maxAdvanceDays })
      .toISODate() as string;
    if (data.latestDate < today) throw new ValidationError("That date range is in the past");
    if (data.earliestDate > horizon) {
      throw new ValidationError(
        `We can only take waitlist requests up to ${context.settings.maxAdvanceDays} days ahead`,
      );
    }
    const earliestDate = data.earliestDate < today ? today : data.earliestDate;
    const latestDate = data.latestDate > horizon ? horizon : data.latestDate;

    const resolution = await resolveServices(tx, data.locationId, serviceIds);
    if (!resolution.ok) throw new ValidationError(resolution.reason);
    const plans = await loadStaffPlans(tx, resolution.services, data.staffId);
    if (plans.length === 0) {
      throw new ValidationError(
        data.staffId
          ? "That stylist does not offer all of the selected services"
          : "No stylist offers all of the selected services together",
      );
    }

    const clientRow = await findOrCreateClient(tx, input.client, context.businessId);
    if (clientRow.blocked) throw new ClientBlockedError();
    const vipService = resolution.services.find((s) => s.vipOnly);
    if (vipService && !clientRow.isVip) throw new VipOnlyError(vipService.name);

    const active = await tx
      .select()
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.clientId, clientRow.id),
          inArray(waitlistEntry.status, [...ACTIVE_ENTRY_STATUSES]),
        ),
      );
    const wanted = {
      staffId: data.staffId ?? null,
      serviceIds,
      earliestDate,
      latestDate,
      ...window,
    };
    const duplicate = active.find(
      (row) => row.locationId === data.locationId && entryKey(row) === entryKey(wanted),
    );
    if (duplicate) return { entryId: duplicate.id };
    if (active.length >= MAX_ACTIVE_ENTRIES_PER_CLIENT) {
      throw new ValidationError(
        `You can be on at most ${MAX_ACTIVE_ENTRIES_PER_CLIENT} waitlists at once. Leave one first.`,
      );
    }

    const expiresAt = DateTime.fromISO(latestDate, { zone: context.timezone })
      .endOf("day")
      .toJSDate();
    const [created] = await tx
      .insert(waitlistEntry)
      .values({
        clientId: clientRow.id,
        locationId: data.locationId,
        staffId: data.staffId ?? null,
        serviceIds,
        earliestDate,
        latestDate,
        weekdays: window.weekdays,
        fromMinute: window.fromMinute,
        toMinute: window.toMinute,
        notes: data.notes ?? null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: waitlistEntry.id });

    await emitDomainEvent(tx, { type: "waitlist.entry_joined", entryId: created.id });
    await recordAudit(tx, {
      actor: "client",
      action: "waitlist.join",
      entityType: "waitlist_entry",
      entityId: created.id,
      data: { locationId: data.locationId, earliestDate, latestDate, staffId: data.staffId },
    });
    return { entryId: created.id };
  });
}

/** Rows an entry can be reloaded into after a status change. */
async function loadEntryForUpdate(db: Db, entryId: string): Promise<EntryRow> {
  if (!isUuid(entryId)) throw new NotFoundError(`Waitlist entry not found: ${entryId}`);
  const [row] = await db
    .select()
    .from(waitlistEntry)
    .where(eq(waitlistEntry.id, entryId))
    .for("update");
  if (!row) throw new NotFoundError(`Waitlist entry not found: ${entryId}`);
  return row;
}

/**
 * Remove an entry (the client from the leave link, or staff). Open offers for it are withdrawn.
 * Idempotent: an entry that is already cancelled, expired or booked is left as it is.
 */
export async function cancelWaitlistEntry(
  db: Db,
  entryId: string,
  by: "client" | "staff",
  options: { actor?: Actor; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await db.transaction(async (tx) => {
    const entry = await loadEntryForUpdate(tx, entryId);
    if (!ACTIVE_ENTRY_STATUSES.some((s) => s === entry.status)) return;

    await tx
      .update(waitlistEntry)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(waitlistEntry.id, entryId));
    await tx
      .update(waitlistOffer)
      .set({ status: "cancelled" })
      .where(and(eq(waitlistOffer.entryId, entryId), eq(waitlistOffer.status, "sent")));
    await recordAudit(tx, {
      actor: options.actor ?? (by === "client" ? "client" : "system"),
      action: "waitlist.cancel",
      entityType: "waitlist_entry",
      entityId: entryId,
      data: { by },
    });
  });
}
