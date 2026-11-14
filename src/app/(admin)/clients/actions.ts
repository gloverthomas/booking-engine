"use server";

import { runAction } from "@/server/admin/action";
import { setClientBlocked, setClientVip, updateClientNotes } from "@/server/admin/clients";
import { mergeClientRecords } from "@/server/admin/commands";
import type { ActionResult } from "@/server/admin/errors";
import { blockedSchema, mergeSchema, notesSchema, vipSchema } from "@/server/admin/schemas";
import { getCommandContext } from "@/server/admin/session";

export async function updateClientNotesAction(raw: unknown): Promise<ActionResult> {
  const ctx = await getCommandContext();
  return runAction("save notes", async () => {
    const { clientId, notes } = notesSchema.parse(raw);
    await updateClientNotes(ctx.db, clientId, notes, ctx.actor);
  });
}

export async function setClientBlockedAction(raw: unknown): Promise<ActionResult> {
  const ctx = await getCommandContext();
  return runAction("update blocked status", async () => {
    const { clientId, blocked } = blockedSchema.parse(raw);
    await setClientBlocked(ctx.db, clientId, blocked, ctx.actor);
  });
}

export async function setClientVipAction(raw: unknown): Promise<ActionResult> {
  const ctx = await getCommandContext();
  return runAction("update VIP status", async () => {
    const { clientId, isVip } = vipSchema.parse(raw);
    await setClientVip(ctx.db, clientId, isVip, ctx.actor);
  });
}

export async function mergeClientsAction(raw: unknown): Promise<ActionResult> {
  const ctx = await getCommandContext();
  return runAction("merge clients", async () => mergeClientRecords(ctx, mergeSchema.parse(raw)));
}
