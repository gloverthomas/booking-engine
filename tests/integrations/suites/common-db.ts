import { beforeEach, describe, expect, test } from "vitest";
import { webhookEvent } from "@/db/schema";
import { withAdvisoryLock } from "@/server/integrations/common/locks";
import { claimOnce, markProcessed } from "@/server/integrations/common/once";
import { NOW, setupTestDb } from "../helpers";

describe("claimOnce and advisory locks", () => {
  const shared = setupTestDb();
  let t: ReturnType<typeof setupTestDb>["current"];
  beforeEach(() => {
    t = shared.current;
  });
  test("first claim wins; an unfinished claim can be retried; a finished one cannot", async () => {
    expect(await claimOnce(t.db, "xero", "k")).toBe(true);
    expect(await claimOnce(t.db, "xero", "k")).toBe(true); // attempt never completed
    await markProcessed(t.db, "xero", "k", NOW);
    expect(await claimOnce(t.db, "xero", "k")).toBe(false);
    expect(await claimOnce(t.db, "google", "k")).toBe(true); // keyed per provider
    expect(await t.db.select().from(webhookEvent)).toHaveLength(2);
  });

  test("withAdvisoryLock runs the callback and returns its value", async () => {
    const result = await withAdvisoryLock(t.db, "x", { wait: true }, async () => 7);
    expect(result).toEqual({ acquired: true, value: 7 });
    const free = await withAdvisoryLock(t.db, "y", { wait: false }, async () => "go");
    expect(free).toEqual({ acquired: true, value: "go" });
  });
});
