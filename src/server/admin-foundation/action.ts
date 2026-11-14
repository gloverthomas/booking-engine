import type { z } from "zod";
import type { Actor } from "@/server/audit";
import type { Db } from "@/server/db-types";
import { isAdminError } from "./errors";

export type ActionResult<T = undefined> =
  { ok: true; data?: T } | { ok: false; error: string; fieldErrors?: Record<string, string> };

export interface ActionContext {
  db: Db;
  /** `owner:<userId>`, the audit actor for everything done inside the action. */
  actor: Actor;
  owner: { userId: string; email: string };
}

export interface OwnerActionDeps {
  /** Redirects (throws) when nobody is signed in. Called outside the try/catch so the redirect propagates. */
  requireOwner: () => Promise<{ userId: string; email: string }>;
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
 * Every admin mutation goes through this: require the owner, validate with zod, then run the handler
 * with a db and an `owner:<id>` audit actor. Server actions in this app are thin wrappers around it.
 * CSRF: Next.js server actions are POST-only and reject cross-origin requests (Origin vs Host), and
 * the session cookie is SameSite=Lax; this wrapper adds the authorisation and validation layer.
 */
export function createOwnerAction(deps: OwnerActionDeps) {
  return async function ownerAction<S extends z.ZodType, T>(
    schema: S,
    input: unknown,
    handler: (parsed: z.output<S>, context: ActionContext) => Promise<T>,
  ): Promise<ActionResult<T>> {
    const owner = await deps.requireOwner();

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: INVALID, fieldErrors: fieldErrorsFrom(parsed.error) };
    }

    try {
      const data = await handler(parsed.data, {
        db: deps.getDb(),
        actor: `owner:${owner.userId}`,
        owner,
      });
      return { ok: true, data };
    } catch (error) {
      if (isAdminError(error)) {
        const fieldErrors =
          Object.keys(error.fieldErrors).length > 0 ? { ...error.fieldErrors } : undefined;
        return { ok: false, error: error.message, ...(fieldErrors ? { fieldErrors } : {}) };
      }
      deps.log({
        event: "owner_action_failed",
        message: error instanceof Error ? error.message : "unknown",
      });
      return { ok: false, error: GENERIC };
    }
  };
}
