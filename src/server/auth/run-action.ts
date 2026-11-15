import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { createAccessAction } from "./access-action";
import { requireAccess } from "./access";

/** The wrapper W1's server actions use: permission check, zod validation, `owner:`/`staff:` actor. */
export const accessAction = createAccessAction({
  requireAccess,
  getDb: () => getDb(),
  log: createLogger("access-action"),
});
