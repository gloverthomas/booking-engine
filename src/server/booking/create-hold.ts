import { z } from "zod";
import { booking, bookingService } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { localDate } from "../availability/engine";
import { resolveServices } from "../availability/loader";
import { searchAvailability } from "../availability";
import { recordAudit } from "../audit";
import { findOrCreateClient } from "../clients";
import type { CreateHoldInput, HoldResult } from "../contracts";
import type { Db } from "../db-types";
import { makeManageToken } from "../manage-token";
import { depositFor } from "../pricing";
import {
  ClientBlockedError,
  PolicyVersionError,
  SlotTakenError,
  ValidationError,
  VipOnlyError,
  isExclusionViolation,
} from "./errors";
import { resolveEncryptionKey, type BookingOptions } from "./shared";
import { expireLapsedHolds } from "./lifecycle";

const MINUTE_MS = 60_000;

const holdInput = z.object({
  locationId: z.uuid(),
  staffId: z.uuid().optional(),
  serviceIds: z.array(z.uuid()).min(1, "Select at least one service"),
  start: z.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid start time"),
  comments: z.string().max(2000).optional(),
  intakeAnswers: z.record(z.string(), z.string().max(2000)).optional(),
  policyVersion: z.string().min(1, "The cancellation policy must be accepted"),
  source: z.string().min(1).max(50).optional(),
});

/**
 * Reserve a slot for a client while they pay the deposit. Everything happens in one transaction:
 * validate, re-check availability, insert a pending_payment booking with a short expiry. The database
 * exclusion constraint is the final guard against double-booking under concurrency.
 */
export async function createHold(
  db: Db,
  input: CreateHoldInput,
  options: BookingOptions = {},
): Promise<HoldResult> {
  const parsed = holdInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid booking request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const key = resolveEncryptionKey(options);
  const now = input.now ?? new Date();

  try {
    return await db.transaction(async (tx) => {
      const context = await getBusinessContext(tx, input.locationId);
      const { settings } = context;
      if (input.policyVersion !== settings.policyVersion) {
        throw new PolicyVersionError(settings.policyVersion, input.policyVersion);
      }

      const resolution = await resolveServices(tx, input.locationId, input.serviceIds);
      if (!resolution.ok) throw new ValidationError(resolution.reason);

      const clientRow = await findOrCreateClient(tx, input.client, context.businessId);
      if (clientRow.blocked) throw new ClientBlockedError();
      const vipService = resolution.services.find((s) => s.vipOnly);
      if (vipService && !clientRow.isVip) throw new VipOnlyError(vipService.name);

      // A lapsed hold still sits in the table (and the exclusion constraint) until swept.
      await expireLapsedHolds(tx, now);

      const day = localDate(input.start, context.timezone);
      const search = await searchAvailability(tx, {
        locationId: input.locationId,
        staffId: input.staffId,
        serviceIds: input.serviceIds,
        fromDate: day,
        toDate: day,
        now,
      });
      const slot = search.slots.find((s) => s.start.getTime() === input.start.getTime());
      const plan = slot ? search.plans.get(slot.staffId) : undefined;
      if (!slot || !plan) throw new SlotTakenError();

      const holdExpiresAt = new Date(now.getTime() + settings.holdMinutes * MINUTE_MS);
      const depositCents = depositFor(
        plan.lines.map((line) => ({
          priceCents: line.priceCents,
          depositPct: line.service.depositPct,
        })),
        settings.depositPct,
      );

      const [created] = await tx
        .insert(booking)
        .values({
          staffId: slot.staffId,
          locationId: input.locationId,
          clientId: clientRow.id,
          status: "pending_payment",
          during: { start: slot.start, end: slot.occupiedEnd },
          totalCents: plan.totalCents,
          depositCents,
          holdExpiresAt,
          bookedForOther: input.bookedForOther ?? false,
          comments: input.comments,
          intakeAnswers: input.intakeAnswers ?? {},
          source: input.source ?? "online",
          policyAcceptedAt: now,
          policyVersion: input.policyVersion,
        })
        .returning({ id: booking.id });

      await tx.insert(bookingService).values(
        plan.lines.map((line, position) => ({
          bookingId: created.id,
          serviceId: line.service.id,
          name: line.service.name,
          durationMin: line.durationMin,
          priceCents: line.priceCents,
          position,
        })),
      );

      await recordAudit(tx, {
        actor: (input.source ?? "online") === "online" ? "client" : "system",
        action: "booking.hold",
        entityType: "booking",
        entityId: created.id,
        data: {
          staffId: slot.staffId,
          start: slot.start.toISOString(),
          totalCents: plan.totalCents,
        },
      });

      return {
        bookingId: created.id,
        manageToken: makeManageToken(created.id, key),
        holdExpiresAt,
        totalCents: plan.totalCents,
        depositCents,
        during: { start: slot.start, end: slot.end },
      };
    });
  } catch (error) {
    if (isExclusionViolation(error)) throw new SlotTakenError();
    throw error;
  }
}
