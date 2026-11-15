"use server";

import { revalidatePath } from "next/cache";
import {
  createTargetCommand,
  deleteTargetCommand,
  updateTargetCommand,
} from "@/server/targets/commands";
import { deleteTargetSchema, targetFormSchema, updateTargetSchema } from "@/server/targets/schemas";
import { accessAction } from "../timesheets/_lib/access-action";

/** Target changes are for the owner and managers (staff.manage). The rules live in src/server/targets. */

export async function createTargetAction(input: unknown) {
  const result = await accessAction("staff.manage", targetFormSchema, input, (p, ctx) =>
    createTargetCommand(ctx, p),
  );
  if (result.ok) revalidatePath("/team", "layout");
  return result;
}

export async function updateTargetAction(input: unknown) {
  const result = await accessAction("staff.manage", updateTargetSchema, input, (p, ctx) =>
    updateTargetCommand(ctx, p),
  );
  if (result.ok) revalidatePath("/team", "layout");
  return result;
}

export async function deleteTargetAction(input: unknown) {
  const result = await accessAction("staff.manage", deleteTargetSchema, input, (p, ctx) =>
    deleteTargetCommand(ctx, p),
  );
  if (result.ok) revalidatePath("/team", "layout");
  return result;
}
