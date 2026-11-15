import type { z } from "zod";
import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { isAdminError } from "../admin-foundation/errors";
import type { ActionResult } from "../admin-foundation/action";
import type { AccessSession } from "../auth/access";
import { requireAccess } from "../auth/access";
import type { Permission } from "../auth/permissions";
import type { Actor } from "../audit";
import type { Db } from "../db-types";
import { auditActorFor } from "./access";

export interface AccessActionContext {
  db: Db;
  /** `owner:<id>` or `staff:<id>`: the audit actor for everything done inside the action. */
  actor: Actor;
  session: AccessSession;
}

export interface AccessActionDeps {
  /** Redirects or throws when the caller lacks the permission. Called outside the try/catch. */
  requireAccess: (permission: Permission) => Promise<AccessSession>;
  getDb: () => Db;
  log: (entry: Record<string, unknown>) => void;
}

const INVALID = "Please fix the highlighted fields.";
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
 * Like the owner action wrapper, but gated by a permission and attributing the audit row to
 * `owner:<id>` or `staff:<id>` depending on the signed-in person's role.
 */
export function createAccessAction(deps: AccessActionDeps) {
  return async function accessAction<S extends z.ZodType, T>(
    permission: Permission,
    schema: S,
    input: unknown,
    handler: (parsed: z.output<S>, context: AccessActionContext) => Promise<T>,
  ): Promise<ActionResult<T>> {
    const session = await deps.requireAccess(permission);

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: INVALID, fieldErrors: fieldErrorsFrom(parsed.error) };
    }

    try {
      const data = await handler(parsed.data, {
        db: deps.getDb(),
        actor: auditActorFor(session),
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

const log = createLogger("roster-action");

/** The wrapper roster server actions use. */
export const rosterAction = createAccessAction({
  requireAccess,
  getDb: () => getDb(),
  log,
});
