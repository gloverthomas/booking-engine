import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { AccessDeniedError, requireAccess } from "@/server/auth/access";
import { createAccessAction } from "./catalog-action";

const log = createLogger("catalog-action");

/** The wrapper catalog server actions use: `requireAccess`, zod validation, `owner:`/`staff:` actor. */
export const catalogAction = createAccessAction({
  requireAccess,
  getDb: () => getDb(),
  log,
  isAccessDenied: (error) => error instanceof AccessDeniedError,
});
