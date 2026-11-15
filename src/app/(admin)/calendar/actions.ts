"use server";

import { runAction } from "@/server/admin/action";
import { createManualBlock, deleteBlock } from "@/server/admin/calendar";
import {
  createStaffBooking,
  reassignStaffBooking,
  rescheduleStaffBooking,
} from "@/server/admin/commands";
import type { ActionResult } from "@/server/admin/errors";
import {
  blockSchema,
  createBookingSchema,
  deleteBlockSchema,
  reassignSchema,
  rescheduleSchema,
} from "@/server/admin/schemas";
import { getCommandContext } from "@/server/admin/session";

export async function createBookingAction(
  raw: unknown,
): Promise<ActionResult<{ bookingId: string }>> {
  return runAction("create booking", async () => {
    const ctx = await getCommandContext("booking.create");
    return createStaffBooking(ctx, createBookingSchema.parse(raw));
  });
}

export async function rescheduleBookingAction(raw: unknown): Promise<ActionResult> {
  return runAction("reschedule booking", async () => {
    const ctx = await getCommandContext("booking.edit");
    await rescheduleStaffBooking(ctx, rescheduleSchema.parse(raw));
  });
}

export async function reassignBookingAction(raw: unknown): Promise<ActionResult> {
  return runAction("change stylist", async () => {
    const ctx = await getCommandContext("booking.edit");
    await reassignStaffBooking(ctx, reassignSchema.parse(raw));
  });
}

export async function createBlockAction(
  raw: unknown,
): Promise<ActionResult<{ blockId: string; overlappingBookings: number }>> {
  return runAction("block time", async () => {
    const ctx = await getCommandContext("calendar.viewAll", "calendar.viewOwn");
    const { staffId, start, end, reason } = blockSchema.parse(raw);
    return createManualBlock(ctx.db, { staffId, start, end, reason }, ctx.actor, ctx.access);
  });
}

export async function deleteBlockAction(raw: unknown): Promise<ActionResult> {
  return runAction("remove blocked time", async () => {
    const ctx = await getCommandContext("calendar.viewAll", "calendar.viewOwn");
    const { blockId } = deleteBlockSchema.parse(raw);
    await deleteBlock(ctx.db, blockId, ctx.actor, ctx.access);
  });
}
