import type { z } from "zod";
import type { StaffRole } from "@/server/contracts";
import type { Actor } from "@/server/audit";
import type { AccessSession } from "@/server/auth/access";
import type { Permission } from "@/server/auth/permissions";
import type { Db } from "@/server/db-types";
import type { ActionResult } from "./action";
import { isAdminError } from "./errors";

export interface CatalogActionContext {
  db: Db;
  /** `owner:<userId>` for the owner, `staff:<userId>` for any other signed-in team member. */
  actor: Actor;
  session: AccessSession;
}

export interface AccessActionDeps {
  /** Redirects (throws) when signed out; throws an access-denied error when the role lacks the permission. */
  requireAccess: (permission: Permission) => Promise<AccessSession>;
  getDb: () => Db;
  log: (entry: Record<string, unknown>) => void;
  /** True for the error `requireAccess` throws when the role lacks the permission. */
  isAccessDenied: (error: unknown) => boolean;
}

const INVALID = "Please fix the highlighted fields.";
const GENERIC = "Something went wrong and nothing was saved. Please try again.";
const DENIED = "You don't have permission to change the catalog.";

export function actorFor(session: { userId: string; role: StaffRole }): Actor {
  return session.role === "owner" ? `owner:${session.userId}` : `staff:${session.userId}`;
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * Catalog mutations go through this: check the permission with `requireAccess`, validate with zod,
 * then run the handler with a db and the right audit actor. Server actions are thin wrappers around it.
 * CSRF: Next.js server actions are POST-only and reject cross-origin requests (Origin vs Host).
 */
export function createAccessAction(deps: AccessActionDeps) {
  return async function accessAction<S extends z.ZodType, T>(
    permission: Permission,
    schema: S,
    input: unknown,
    handler: (parsed: z.output<S>, context: CatalogActionContext) => Promise<T>,
  ): Promise<ActionResult<T>> {
    let session: AccessSession;
    try {
      session = await deps.requireAccess(permission);
    } catch (error) {
      // A signed-out redirect must propagate; only a refused permission becomes a message.
      if (deps.isAccessDenied(error)) return { ok: false, error: DENIED };
      throw error;
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: INVALID, fieldErrors: fieldErrorsFrom(parsed.error) };
    }

    try {
      const data = await handler(parsed.data, {
        db: deps.getDb(),
        actor: actorFor(session),
        session,
      });
      return { ok: true, data };
    } catch (error) {
      if (isAdminError(error)) {
        const fieldErrors =
          Object.keys(error.fieldErrors).length > 0 ? { ...error.fieldErrors } : undefined;
        return { ok: false, error: error.message, ...(fieldErrors ? { fieldErrors } : {}) };
      }
      deps.log({
        event: "catalog_action_failed",
        message: error instanceof Error ? error.message : "unknown",
      });
      return { ok: false, error: GENERIC };
    }
  };
}
