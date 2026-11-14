import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { requireOwner } from "@/server/auth";
import { createOwnerAction } from "./action";

const log = createLogger("admin-action");

/** The wrapper server actions use: owner check, zod validation, `owner:<id>` actor. */
export const ownerAction = createOwnerAction({
  requireOwner,
  getDb: () => getDb(),
  log,
});
