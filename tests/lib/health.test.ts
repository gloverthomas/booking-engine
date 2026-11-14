import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { checkHealth } from "@/lib/health";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.client.close().catch(() => undefined);
});

describe("checkHealth", () => {
  test("reports ok when the database answers", async () => {
    const result = await checkHealth(t.db);
    expect(result.ok).toBe(true);
    expect(result.checks.database).toBe("up");
  });

  test("reports not ok when the database is unreachable, without leaking the error", async () => {
    await t.client.close();
    const result = await checkHealth(t.db);
    expect(result.ok).toBe(false);
    expect(result.checks.database).toBe("down");
    expect(JSON.stringify(result)).not.toMatch(/closed|postgres|stack/i);
  });
});
