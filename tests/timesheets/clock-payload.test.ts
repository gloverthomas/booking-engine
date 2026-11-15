import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clockIn } from "@/server/timesheets/clock";
import { buildClockPayload } from "@/server/timesheets/clock-payload";
import { createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";
import "../reports/timeouts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
const TZ = "Australia/Melbourne";
const NOW = () => new Date("2026-11-19T01:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterAll(async () => {
  await t.client.close();
});

describe("buildClockPayload", () => {
  test("no staff profile means the widget stays hidden", async () => {
    expect(await buildClockPayload(t.db, { staffId: null, timezone: TZ }, NOW)).toEqual({
      available: false,
    });
  });

  test("clocked out: locations to choose from and the server time", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "p1@example.com" });
    const payload = await buildClockPayload(t.db, { staffId: person.id, timezone: TZ }, NOW);
    expect(payload).toMatchObject({
      available: true,
      serverNow: "2026-11-19T01:00:00.000Z",
      open: null,
    });
    expect(payload.available && payload.locations.map((l) => l.name)).toEqual(["Northside"]);
  });

  test("clocked in: the start time is business local", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "p2@example.com" });
    await clockIn(
      t.db,
      { staffId: person.id, locationId: seed.loc.id, actor: "staff:u" },
      () => new Date("2026-11-18T22:02:00Z"),
    );
    const payload = await buildClockPayload(t.db, { staffId: person.id, timezone: TZ }, NOW);
    expect(payload.available && payload.open).toEqual({
      since: "2026-11-18T22:02:00.000Z",
      sinceLabel: "9:02 am",
      locationName: "Northside",
    });
  });
});
