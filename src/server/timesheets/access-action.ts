import { z } from "zod";
import type { ActionResult } from "@/server/admin-foundation/action";
import type { Actor } from "../audit";
import type { StaffRole } from "../contracts";
import type { Db } from "../db-types";
import { isTimesheetError } from "./errors";

/** What the guard returns (the same shape as AccessSession in src/server/auth/access.ts). */
export interface ActionSession {
  userId: string;
  email: string;
  staffId: string | null;
  role: StaffRole;
}

export interface AccessActionContext {
  db: Db;
  session: ActionSession;
  actor: Actor;
}

export interface AccessActionDeps<P extends string> {
  /** Redirects (throws) when signed out, throws when the role lacks the permission. Called outside the try/catch. */
  requireAccess: (permission: P) => Promise<ActionSession>;
  getDb: () => Db;
  isAccessDenied: (error: unknown) => boolean;
  log: (entry: Record<string, unknown>) => void;
}

/** `owner:<userId>` for the owner, `staff:<userId>` for everyone else. */
export function actorFor(session: Pick<ActionSession, "role" | "userId">): Actor {
  return session.role === "owner" ? `owner:${session.userId}` : `staff:${session.userId}`;
}

const INVALID = "Please fix the highlighted fields.";
const DENIED = "You do not have permission to do that.";
const GENERIC = "Something went wrong and nothing was saved. Please try again.";

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * Every timesheet, target and report mutation goes through this: check the permission, validate with zod, run
 * the handler with a db and an audit actor, and turn domain errors into a friendly result. Server actions are
 * thin wrappers around it. CSRF: server actions are POST-only and Next rejects cross-origin requests.
 */
export function createAccessAction<P extends string>(deps: AccessActionDeps<P>) {
  return async function accessAction<S extends z.ZodType, T>(
    permission: P,
    schema: S,
    input: unknown,
    handler: (parsed: z.output<S>, context: AccessActionContext) => Promise<T>,
  ): Promise<ActionResult<T>> {
    let session: ActionSession;
    try {
      session = await deps.requireAccess(permission);
    } catch (error) {
      if (deps.isAccessDenied(error)) return { ok: false, error: DENIED };
      throw error; // a redirect to /login must propagate
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: INVALID, fieldErrors: fieldErrorsFrom(parsed.error) };
    }

    try {
      const data = await handler(parsed.data, {
        db: deps.getDb(),
        session,
        actor: actorFor(session),
      });
      return { ok: true, data };
    } catch (error) {
      if (isTimesheetError(error)) {
        const fieldErrors =
          Object.keys(error.fieldErrors).length > 0 ? { ...error.fieldErrors } : undefined;
        return { ok: false, error: error.message, ...(fieldErrors ? { fieldErrors } : {}) };
      }
      deps.log({
        event: "access_action_failed",
        permission,
        message: error instanceof Error ? error.message : "unknown",
      });
      return { ok: false, error: GENERIC };
    }
  };
}
