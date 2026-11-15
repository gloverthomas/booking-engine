import { after } from "next/server";
import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { requireOwner } from "@/server/auth";
import { requireAccess } from "@/server/auth/access";
import { loadIntegrationEnv } from "@/server/integrations/common/env";
import type { GoogleRouteDeps } from "@/server/integrations/google/routes";
import type { XeroRouteDeps } from "@/server/integrations/xero/routes";

/** Wiring for the route handlers: real db, env, logger, owner guard and Next's `after`. */

export function googleRouteDeps(): GoogleRouteDeps {
  return {
    db: getDb(),
    env: loadIntegrationEnv(),
    now: () => new Date(),
    log: createLogger("google"),
    requireAccess,
    runAfter: (task) => after(task),
  };
}

export function xeroRouteDeps(): XeroRouteDeps {
  return {
    db: getDb(),
    env: loadIntegrationEnv(),
    now: () => new Date(),
    log: createLogger("xero"),
    requireOwner,
    runAfter: (task) => after(task),
  };
}
