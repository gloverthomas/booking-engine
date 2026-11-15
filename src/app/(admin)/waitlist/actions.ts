"use server";

import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import type { Actor } from "@/server/audit";
import { requireAccess } from "@/server/auth/access";
import { userFacingMessage } from "@/server/admin/action";
import type { ActionResult } from "@/server/admin-foundation/action";
import { offerSlot, removeEntry } from "@/server/waitlist";

const log = createLogger("waitlist-admin");

type StaffActor = Extract<Actor, `owner:${string}` | `staff:${string}`>;

/** `owner:<id>` for the owner, `staff:<id>` for any other signed-in team member. */
async function currentActor(): Promise<StaffActor> {
  const session = await requireAccess("waitlist.manage");
  return session.role === "owner" ? `owner:${session.userId}` : `staff:${session.userId}`;
}

async function run<T>(name: string, body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
    log({
      level: "error",
      event: "waitlist_admin_action_failed",
      action: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: userFacingMessage(error) };
  }
}

/** Remove someone from the waitlist. Their open offers are withdrawn. */
export async function removeEntryAction(raw: unknown): Promise<ActionResult> {
  const actor = await currentActor();
  return run("remove entry", () => removeEntry(getDb(), raw, actor).then(() => undefined));
}

/** Offer a specific open time to a waitlist person, overriding auto-offer. */
export async function offerSlotAction(raw: unknown): Promise<ActionResult<{ offerId: string }>> {
  const actor = await currentActor();
  return run("offer slot", () => offerSlot(getDb(), raw, actor));
}
