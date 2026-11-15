import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { booking, bookingService, staff } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { localDate, rosterCovers } from "../availability/engine";
import {
  loadBusy,
  loadExceptions,
  loadRules,
  loadStaffPlans,
  resolveServices,
} from "../availability/loader";
import { recordAudit, type Actor } from "../audit";
import type { ReassignInput } from "../contracts";
import type { Db } from "../db-types";
import { emitDomainEvent } from "../events";
import {
  BookingStateError,
  NotFoundError,
  NotRosteredError,
  SlotTakenError,
  ValidationError,
  isExclusionViolation,
} from "./errors";
import { expireLapsedHolds } from "./lifecycle";
import { isUuid, loadBookingForUpdate } from "./shared";

const MINUTE_MS = 60_000;

const ACTOR = /^(owner|staff):.+$/;

const reassignInput = z.object({
  bookingId: z.string().min(1),
  newStaffId: z.string().min(1),
  notifyClient: z.boolean().optional(),
  actor: z.string().regex(ACTOR, "Actor must look like owner:<id> or staff:<id>").optional(),
});

/**
 * Move a confirmed, future booking to another stylist at the same time.
 *
 * The new stylist must be active, rostered for the whole appointment (weekly hours and day exceptions),
 * free for the whole occupied span, and offer every service at the booking's location. Prices are
 * re-resolved through priceFor for the new stylist's level: the deposit already paid is never touched,
 * the client's total stays the same unless the prices differ, in which case the new total is stored and
 * the difference goes in the audit row. Emits booking.rescheduled and writes an audit row.
 */
export async function reassignBooking(db: Db, input: ReassignInput): Promise<void> {
  const parsed = reassignInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid reassignment",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  if (!isUuid(input.newStaffId))
    throw new NotFoundError(`Staff member not found: ${input.newStaffId}`);
  const now = input.now ?? new Date();
  const actor: Actor = input.actor ? (input.actor as Actor) : "system";

  try {
    await db.transaction(async (tx) => {
      const row = await loadBookingForUpdate(tx, input.bookingId);
      if (row.status !== "confirmed") {
        throw new BookingStateError(`Cannot reassign a booking that is ${row.status}`, row.status);
      }
      if (row.during.start.getTime() <= now.getTime()) {
        throw new BookingStateError("Only a booking that has not started yet can be reassigned");
      }
      if (row.staffId === input.newStaffId) {
        throw new ValidationError("The booking is already with that stylist");
      }

      const [newStylist] = await tx.select().from(staff).where(eq(staff.id, input.newStaffId));
      if (!newStylist) throw new NotFoundError(`Staff member not found: ${input.newStaffId}`);
      if (!newStylist.active) throw new ValidationError(`${newStylist.name} is not active`);

      const lines = await tx
        .select()
        .from(bookingService)
        .where(eq(bookingService.bookingId, row.id))
        .orderBy(asc(bookingService.position));
      const serviceIds = lines.flatMap((line) => (line.serviceId ? [line.serviceId] : []));
      if (lines.length === 0 || serviceIds.length !== lines.length) {
        throw new ValidationError(
          "This booking has no catalogue services to check the stylist against",
        );
      }

      const resolution = await resolveServices(tx, row.locationId, serviceIds);
      if (!resolution.ok) throw new ValidationError(resolution.reason);
      const [plan] = await loadStaffPlans(tx, resolution.services, newStylist.id);
      if (!plan) {
        throw new ValidationError(
          `${newStylist.name} does not offer every service in this booking`,
        );
      }

      const context = await getBusinessContext(tx, row.locationId);
      const date = localDate(row.during.start, context.timezone);
      const [rules, exceptions] = await Promise.all([
        loadRules(tx, row.locationId, [newStylist.id]),
        loadExceptions(tx, row.locationId, [newStylist.id], date, date),
      ]);
      // The buffer is padding after the appointment and may run past closing time.
      const appointment = {
        start: row.during.start,
        end: new Date(row.during.end.getTime() - plan.bufferMin * MINUTE_MS),
      };
      if (
        !rosterCovers(
          rules.get(newStylist.id) ?? [],
          exceptions.get(newStylist.id) ?? [],
          context.timezone,
          appointment,
        )
      ) {
        throw new NotRosteredError(`${newStylist.name} is not working at that time`);
      }

      await expireLapsedHolds(tx, now);
      const busy = await loadBusy(tx, [newStylist.id], row.during, now, row.id);
      if ((busy.get(newStylist.id) ?? []).length > 0) throw new SlotTakenError();

      const previousTotalCents = row.totalCents;
      const totalCents = plan.totalCents;
      const priceByService = new Map(plan.lines.map((line) => [line.service.id, line.priceCents]));
      for (const line of lines) {
        const priceCents = line.serviceId ? priceByService.get(line.serviceId) : undefined;
        if (priceCents !== undefined && priceCents !== line.priceCents) {
          await tx.update(bookingService).set({ priceCents }).where(eq(bookingService.id, line.id));
        }
      }
      // The time and the deposit already paid stay as they are; only the stylist and (maybe) the total move.
      await tx
        .update(booking)
        .set({ staffId: newStylist.id, totalCents, updatedAt: now })
        .where(eq(booking.id, row.id));

      await emitDomainEvent(tx, {
        type: "booking.rescheduled",
        bookingId: row.id,
        previousStart: row.during.start.toISOString(),
        notifyClient: input.notifyClient ?? true,
      });
      await recordAudit(tx, {
        actor,
        action: "booking.reassign",
        entityType: "booking",
        entityId: row.id,
        data: {
          fromStaffId: row.staffId,
          toStaffId: newStylist.id,
          start: row.during.start.toISOString(),
          previousTotalCents,
          totalCents,
          totalDifferenceCents: totalCents - previousTotalCents,
          depositCents: row.depositCents,
          newStylistLevel: plan.level,
          notifyClient: input.notifyClient ?? true,
        },
      });
    });
  } catch (error) {
    if (isExclusionViolation(error)) throw new SlotTakenError();
    throw error;
  }
}
