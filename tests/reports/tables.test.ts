import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { createTestDb } from "../helpers/test-db";
import "./timeouts";
import { client } from "@/db/schema";
import {
  REPORT_TABLE_IDS,
  buildReportTable,
  isReportTableId,
  loadBusinessContext,
  resolveParams,
  tableToCsv,
} from "@/server/reports";
import { NOW, seedReportFixture, TZ, type Fixture } from "./fixture";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let fx: Fixture;

beforeAll(async () => {
  t = await createTestDb();
  fx = await seedReportFixture(t.db);
});
afterAll(async () => {
  await t.client.close();
});

const ctx = (query: Record<string, string | string[] | undefined> = {}) => ({
  timezone: TZ,
  now: NOW,
  query: { from: "2026-11-01", to: "2026-11-30", ...query },
});

describe("resolveParams", () => {
  test("defaults to month to date and week buckets", () => {
    expect(resolveParams({}, TZ, NOW)).toEqual({
      from: "2026-11-01",
      to: "2026-11-14",
      granularity: "week",
      groupBy: "none",
    });
  });
  test("takes the first value of repeated params and ignores empty strings", () => {
    const p = resolveParams({ from: ["2026-10-01", "x"], to: "", groupBy: "service" }, TZ, NOW);
    expect(p).toMatchObject({ from: "2026-10-01", to: "2026-11-14", groupBy: "service" });
  });
  test("rejects garbage", () => {
    expect(() => resolveParams({ from: "yesterday" }, TZ, NOW)).toThrow(ZodError);
    expect(() => resolveParams({ granularity: "year" }, TZ, NOW)).toThrow(ZodError);
  });
});

describe("report tables", () => {
  test("every registered id builds a table with matching columns", async () => {
    for (const id of REPORT_TABLE_IDS) {
      const table = await buildReportTable(t.db, id, ctx());
      expect(table.id).toBe(id);
      expect(table.title.length).toBeGreaterThan(0);
      expect(table.columns.length).toBeGreaterThan(0);
      const csv = tableToCsv(table);
      expect(csv.split("\r\n")).toHaveLength(table.rows.length + 2); // header + rows + trailing newline
    }
    expect(isReportTableId("revenue")).toBe(true);
    expect(isReportTableId("../etc/passwd")).toBe(false);
  });

  test("revenue table respects grouping and shows money as dollars in CSV", async () => {
    const table = await buildReportTable(
      t.db,
      "revenue",
      ctx({ granularity: "month", groupBy: "location" }),
    );
    expect(table.columns[1]).toMatchObject({ key: "group", header: "Location" });
    const csv = tableToCsv(table).replace("\uFEFF", "").split("\r\n");
    expect(csv[0]).toBe(
      "Month,Location,Deposits,Balances,Fees charged,Gross,Refunds,Net,Fees kept",
    );
    expect(csv).toContain("Nov 2026,Northside,237.50,47.50,19.00,304.00,47.50,256.50,114.00");
    expect(csv).toContain("Nov 2026,Southside,62.50,62.50,0.00,125.00,0.00,125.00,0.00");

    const plain = await buildReportTable(t.db, "revenue", ctx({ granularity: "month" }));
    expect(plain.columns.map((c) => c.key)).not.toContain("group");
    const svc = await buildReportTable(t.db, "revenue", ctx({ groupBy: "service" }));
    expect(svc.columns[1].header).toBe("Service");
  });

  test("cancellations and outstanding tables use readable local times and labels", async () => {
    const c = await buildReportTable(t.db, "cancellations", ctx());
    expect(c.rows[1]).toMatchObject({ statusLabel: "No-show", start: "2026-11-13 11:00" });
    const o = await buildReportTable(t.db, "outstanding", ctx());
    expect(o.rows[0]).toMatchObject({ stateLabel: "Overdue", start: "2026-11-09 16:00" });
    expect(o.rows[1]).toMatchObject({ stateLabel: "Due at appointment" });
  });

  test("weekday table starts on Monday; client tables format dates", async () => {
    const w = await buildReportTable(t.db, "busiest-weekdays", ctx());
    expect(w.rows.map((r) => (r as { label: string }).label)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    const top = await buildReportTable(t.db, "top-clients", ctx());
    expect(top.rows[0]).toMatchObject({ name: "Alex Brown", lastVisit: "2026-11-07" });
    const lapsed = await buildReportTable(t.db, "lapsed-clients", ctx());
    expect(lapsed.title).toContain("90");
    expect(lapsed.rows[0]).toMatchObject({ name: "Pat Dunn", lastVisit: "2026-08-05" });
  });

  test("a client named like a spreadsheet formula is neutralised in the CSV", async () => {
    await t.db
      .update(client)
      .set({ firstName: '=HYPERLINK("http://evil.example","click")', lastName: "Dunn" })
      .where(eq(client.id, fx.clients.pat));
    const lapsed = await buildReportTable(t.db, "lapsed-clients", ctx());
    const csv = tableToCsv(lapsed);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"") Dunn"`);
    expect(csv).not.toMatch(/(^|\r\n)=/);
  });

  test("rejects bad input as a ZodError", async () => {
    await expect(buildReportTable(t.db, "revenue", ctx({ from: "nope" }))).rejects.toBeInstanceOf(
      ZodError,
    );
  });
});

describe("loadBusinessContext", () => {
  test("returns the single business row, or a readable error when there is none", async () => {
    const found = await loadBusinessContext(t.db);
    expect(found).toMatchObject({ businessId: fx.businessId, timezone: TZ });
    const empty = await createTestDb();
    await expect(loadBusinessContext(empty.db)).rejects.toThrow(/No business/);
    await empty.client.close();
  });
});
