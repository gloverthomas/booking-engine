"use server";

import { runAction } from "@/server/admin/action";
import { createManualBlock, deleteBlock } from "@/server/admin/calendar";
import { createStaffBooking, rescheduleStaffBooking } from "@/server/admin/commands";
import type { ActionResult } from "@/server/admin/errors";
import {
  blockSchema,
  createBookingSchema,
  deleteBlockSchema,
  rescheduleSchema,
} from "@/server/admin/schemas";
import { getCommandContext } from "@/server/admin/session";

export async function createBookingAction(
  raw: unknown,
): Promise<ActionResult<{ bookingId: string }>> {
  const ctx = await getCommandContext();
  return runAction("create booking", async () =>
    createStaffBooking(ctx, createBookingSchema.parse(raw)),
  );
}

export async function rescheduleBookingAction(raw: unknown): Promise<ActionResult> {
  const ctx = await getCommandContext();
  return runAction("reschedule booking", async () =>
    rescheduleStaffBooking(ctx, rescheduleSchema.parse(raw)),
  );
}

export async function createBlockAction(
  raw: unknown,
): Promise<ActionResult<{ blockId: string; overlappingBookings: number }>> {
  const ctx = await getCommandContext();
  return runAction("block time", async () => {
    const { staffId, start, end, reason } = blockSchema.parse(raw);
    return createManualBlock(ctx.db, { staffId, start, end, reason }, ctx.actor);
  });
}

export async function deleteBlockAction(raw: unknown): Promise<ActionResult> {
  const ctx = await getCommandContext();
  return runAction("remove blocked time", async () => {
    const { blockId } = deleteBlockSchema.parse(raw);
    await deleteBlock(ctx.db, blockId, ctx.actor);
  });
}
