import { describe, expect, test } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { account, session, user, verification } from "@/db/auth-schema";
import { createTestDb } from "../helpers/test-db";
import { getBusiness } from "@/server/admin-foundation/business";
import { isAdminError } from "@/server/admin-foundation/errors";

describe("auth schema", () => {
  test("sessions and accounts cascade-delete with their user", () => {
    for (const table of [session, account]) {
      const [fk] = getTableConfig(table).foreignKeys;
      const ref = fk?.reference();
      expect(ref?.foreignTable).toBe(user);
      expect(fk?.onDelete).toBe("cascade");
    }
  });

  test("uses Better Auth's table names", () => {
    expect([user, session, account, verification].map((t) => getTableConfig(t).name)).toEqual([
      "user",
      "session",
      "account",
      "verification",
    ]);
  });

  test("the migration creates all four tables", async () => {
    const { client } = await createTestDb();
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('user','session','account','verification')",
    );
    expect(result.rows.map((r) => r.table_name).sort()).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
    await client.close();
  });
});

describe("getBusiness", () => {
  test("explains how to fix an empty database", async () => {
    const { db, client } = await createTestDb();
    const failure = await getBusiness(db).catch((error: unknown) => error);
    expect(isAdminError(failure)).toBe(true);
    expect((failure as Error).message).toMatch(/db:seed/);
    await client.close();
  });
});
