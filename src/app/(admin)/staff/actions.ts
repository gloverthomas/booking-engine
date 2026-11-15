"use server";

import { getEnv } from "@/lib/env";
import type { AccessActionContext } from "@/server/auth/access-action";
import { parseOwnerEmails } from "@/server/auth/owners";
import { accessAction } from "@/server/auth/run-action";
import {
  createStaffMember,
  setStaffActive,
  updateStaffMember,
  type StaffCommandContext,
} from "@/server/staff/commands";
import { staffActiveSchema, staffIdSchema, staffInputSchema } from "@/server/staff/schemas";

const updateSchema = staffInputSchema.extend(staffIdSchema.shape);

function commandContext({ db, actor, session }: AccessActionContext): StaffCommandContext {
  return {
    db,
    actor,
    caller: { role: session.role, staffId: session.staffId },
    ownerEmails: parseOwnerEmails(getEnv().OWNER_EMAILS),
  };
}

export async function createStaffAction(input: unknown) {
  return accessAction("staff.manage", staffInputSchema, input, (parsed, ctx) =>
    createStaffMember(commandContext(ctx), parsed),
  );
}

export async function updateStaffAction(input: unknown) {
  return accessAction("staff.manage", updateSchema, input, async ({ id, ...parsed }, ctx) => {
    await updateStaffMember(commandContext(ctx), id, parsed);
  });
}

export async function setStaffActiveAction(input: unknown) {
  return accessAction("staff.manage", staffActiveSchema, input, async (parsed, ctx) => {
    await setStaffActive(commandContext(ctx), parsed.id, parsed.active);
  });
}
