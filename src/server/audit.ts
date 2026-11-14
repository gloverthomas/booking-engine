import { auditLog } from "@/db/schema";
import type { Db } from "./db-types";

/** `owner:<userId>` for the owner, `staff:<userId>` for any other signed-in team member. */
export type Actor = `owner:${string}` | `staff:${string}` | "mcp" | "system" | "client";

export interface AuditEntry {
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string;
  data?: Record<string, unknown>;
}

/** Record who did what. Call inside the same transaction as the change. Never put secrets or card data in `data`. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    data: entry.data ?? {},
  });
}
