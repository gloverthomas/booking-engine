import { getDb } from "@/db/client";
import type { Actor } from "../audit";
import { AccessDeniedError, requireAccess, type AccessSession } from "../auth/access";
import type { Permission } from "../auth/permissions";
import type { Db } from "../db-types";
import { actorFor, viewerCaps, type AccessContext } from "./access";
import type { CommandContext } from "./commands";
import { realDomain } from "./domain";
import type { ViewerCaps } from "./types";

/**
 * Entry points for server actions, pages and route handlers. They resolve who is signed in through
 * `requireAccess(permission)` (a redirect to /login when signed out, AccessDeniedError when the role lacks
 * the permission). Pass more than one permission when either is enough, e.g. a stylist has
 * `calendar.viewOwn` while reception has `calendar.viewAll`.
 */
async function resolveSession(
  permission: Permission,
  alternatives: readonly Permission[],
): Promise<AccessSession> {
  let denied: AccessDeniedError | undefined;
  for (const candidate of [permission, ...alternatives]) {
    try {
      return await requireAccess(candidate);
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      denied ??= error;
    }
  }
  throw denied;
}

function toAccess(session: AccessSession): AccessContext {
  return { role: session.role, staffId: session.staffId };
}

export async function getCommandContext(
  permission: Permission,
  ...alternatives: Permission[]
): Promise<CommandContext> {
  const session = await resolveSession(permission, alternatives);
  return {
    db: getDb(),
    actor: actorFor(session.userId, session.role),
    access: toAccess(session),
    domain: realDomain,
  };
}

export interface ReadContext {
  db: Db;
  actor: Actor;
  access: AccessContext;
  caps: ViewerCaps;
}

export async function getReadContext(
  permission: Permission,
  ...alternatives: Permission[]
): Promise<ReadContext> {
  const session = await resolveSession(permission, alternatives);
  const access = toAccess(session);
  return {
    db: getDb(),
    actor: actorFor(session.userId, session.role),
    access,
    caps: viewerCaps(access),
  };
}

/** Anyone who can open the calendar: a stylist sees their own column, reception and up see everyone's. */
export const CALENDAR_PERMISSIONS = ["calendar.viewAll", "calendar.viewOwn"] as const;

export function getCalendarReadContext(): Promise<ReadContext> {
  return getReadContext(...CALENDAR_PERMISSIONS);
}

export function getCalendarCommandContext(): Promise<CommandContext> {
  return getCommandContext(...CALENDAR_PERMISSIONS);
}
