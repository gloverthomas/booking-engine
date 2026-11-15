import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { AccessDeniedError, requireAccess } from "@/server/auth/access";
import type { Permission } from "@/server/auth/permissions";
import { createAccessAction } from "@/server/timesheets/access-action";

const log = createLogger("timesheets-action");

/**
 * The wrapper the timesheet and target server actions use: permission check, zod validation, an
 * `owner:<id>` / `staff:<id>` audit actor, and friendly errors. See src/server/timesheets/access-action.ts.
 */
export const accessAction = createAccessAction<Permission>({
  requireAccess,
  getDb: () => getDb(),
  isAccessDenied: (error) => error instanceof AccessDeniedError,
  log,
});
