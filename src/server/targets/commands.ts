import type { Actor } from "../audit";
import type { Db } from "../db-types";
import { createTarget, deleteTarget, updateTarget, type TargetInput } from "./crud";
import type { TargetForm } from "./schemas";
import { parseTargetInput } from "./units";

export interface TargetCommandContext {
  db: Db;
  actor: Actor;
}

function toInput(form: TargetForm): TargetInput {
  return {
    staffId: form.staffId ?? null,
    metric: form.metric,
    period: form.period,
    targetValue: parseTargetInput(form.metric, form.targetValue),
    validFrom: form.validFrom,
    validTo: form.validTo ?? null,
  };
}

export async function createTargetCommand(
  ctx: TargetCommandContext,
  form: TargetForm,
): Promise<{ id: string }> {
  return { id: await createTarget(ctx.db, toInput(form), ctx.actor) };
}

export async function updateTargetCommand(
  ctx: TargetCommandContext,
  form: TargetForm & { id: string },
): Promise<{ id: string }> {
  await updateTarget(ctx.db, form.id, toInput(form), ctx.actor);
  return { id: form.id };
}

export async function deleteTargetCommand(
  ctx: TargetCommandContext,
  input: { id: string },
): Promise<{ id: string }> {
  await deleteTarget(ctx.db, input.id, ctx.actor);
  return { id: input.id };
}
