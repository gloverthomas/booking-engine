"use server";

import { revalidatePath } from "next/cache";
import { loadBusinessContext } from "@/server/reports/context";
import type { AccessActionContext } from "@/server/timesheets/access-action";
import {
  addManualEntryCommand,
  approveEntriesCommand,
  clockInCommand,
  clockOutCommand,
  editEntryCommand,
  type CommandContext,
} from "@/server/timesheets/commands";
import {
  approveEntriesSchema,
  clockInSchema,
  clockOutSchema,
  editEntrySchema,
  manualEntrySchema,
} from "@/server/timesheets/schemas";
import { accessAction } from "./_lib/access-action";

/** The server actions behind the Clock widget and the timesheet page. Thin wrappers: the rules live in src/server/timesheets. */

async function commandContext(ctx: AccessActionContext): Promise<CommandContext> {
  const { timezone } = await loadBusinessContext(ctx.db);
  return { db: ctx.db, actor: ctx.actor, staffId: ctx.session.staffId, timezone };
}

export async function clockInAction(input: unknown) {
  const result = await accessAction("timesheets.clock", clockInSchema, input, async (p, ctx) =>
    clockInCommand(await commandContext(ctx), p),
  );
  if (result.ok) revalidatePath("/timesheets");
  return result;
}

export async function clockOutAction(input: unknown) {
  const result = await accessAction("timesheets.clock", clockOutSchema, input, async (p, ctx) =>
    clockOutCommand(await commandContext(ctx), p),
  );
  if (result.ok) revalidatePath("/timesheets");
  return result;
}

export async function addManualEntryAction(input: unknown) {
  const result = await accessAction(
    "timesheets.approve",
    manualEntrySchema,
    input,
    async (p, ctx) => addManualEntryCommand(await commandContext(ctx), p),
  );
  if (result.ok) revalidatePath("/timesheets");
  return result;
}

export async function editEntryAction(input: unknown) {
  const result = await accessAction("timesheets.approve", editEntrySchema, input, async (p, ctx) =>
    editEntryCommand(await commandContext(ctx), p),
  );
  if (result.ok) revalidatePath("/timesheets");
  return result;
}

export async function approveEntriesAction(input: unknown) {
  const result = await accessAction(
    "timesheets.approve",
    approveEntriesSchema,
    input,
    async (p, ctx) => approveEntriesCommand(await commandContext(ctx), p),
  );
  if (result.ok) revalidatePath("/timesheets");
  return result;
}
