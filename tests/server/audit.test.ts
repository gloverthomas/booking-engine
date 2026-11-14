import { describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { auditLog } from "@/db/schema";
import { recordAudit } from "@/server/audit";

describe("recordAudit", () => {
  test("writes an audit row with actor, action and entity", async () => {
    const { db, client } = await createTestDb();
    await recordAudit(db, {
      actor: "mcp",
      action: "booking.moved",
      entityType: "booking",
      entityId: "b1",
      data: { to: "2026-11-21T04:00:00Z" },
    });
    await recordAudit(db, { actor: "system", action: "x", entityType: "y" });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entityId === "b1")).toMatchObject({
      actor: "mcp",
      action: "booking.moved",
      data: { to: "2026-11-21T04:00:00Z" },
    });
    await client.close();
  });
});
