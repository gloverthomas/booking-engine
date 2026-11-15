import type { z } from "zod";
import type { Actor } from "@/server/audit";
import type { Db } from "@/server/db-types";
import { isAdminError } from "@/server/admin-foundation/errors";
import type { ActionResult } from "@/server/admin-foundation/action";
import { actorFor, AccessDeniedError, type AccessSession } from "./access-core";
import type { Permission } from "./permissions";

export interface AccessActionContext {
  db: Db;
  /** `owner:<userId>` or `staff:<userId>`, the audit actor for everything done inside the action. */
  actor: Actor;
  session: AccessSession;
}

export interface AccessActionDeps {
  /** Redirects (throws) when nobody is signed in; throws AccessDeniedError for a missing permission. */
  requireAccess: (permission: Permission) => Promise<AccessSession>;
  getDb: () => Db;
  log: (entry: Record<string, unknown>) => void;
}

const INVALID = "Please fix the highlighted fields.";
const GENERIC = "Something went wrong and nothing was saved. Please try again.";
export const NOT_ALLOWED = "You don't have permission to do that.";

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * The role-aware sibling of ownerAction: require a permission, validate with zod, then run the handler
 * with a db and an `owner:<id>` / `staff:<id>` audit actor. Server actions are thin wrappers around it.
 * CSRF: Next.js server actions are POST-only and check Origin against Host, and the session cookie is
 * SameSite=Lax; this wrapper adds the authorisation and validation layer.
 */
export function createAccessAction(deps: AccessActionDeps) {
  return async function accessAction<S extends z.ZodType, T>(
    permission: Permission,
    schema: S,
    input: unknown,
    handler: (parsed: z.output<S>, context: AccessActionContext) => Promise<T>,
  ): Promise<ActionResult<T>> {
    let session: AccessSession;
    try {
      session = await deps.requireAccess(permission);
    } catch (error) {
      // A missing permission is an answer for the form; a redirect to /login must keep propagating.
      if (error instanceof AccessDeniedError) return { ok: false, error: NOT_ALLOWED };
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
        event: "access_action_failed",
        message: error instanceof Error ? error.message : "unknown",
      });
      return { ok: false, error: GENERIC };
    }
  };
}
