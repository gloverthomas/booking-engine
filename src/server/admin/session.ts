import { getDb } from "@/db/client";
import type { Actor } from "../audit";
import { requireOwner } from "../auth";
import type { Db } from "../db-types";
import type { CommandContext } from "./commands";
import { realDomain } from "./domain";

/**
 * Entry points for server actions and route handlers. `requireOwner()` runs first, outside any
 * try/catch, so its redirect to /login is never swallowed by an action's error handling.
 */
export async function getCommandContext(): Promise<CommandContext> {
  const owner = await requireOwner();
  const actor: Actor = `owner:${owner.userId}`;
  return { db: getDb(), actor, domain: realDomain };
}

export async function getReadContext(): Promise<{ db: Db; actor: Actor }> {
  const owner = await requireOwner();
  return { db: getDb(), actor: `owner:${owner.userId}` };
}
