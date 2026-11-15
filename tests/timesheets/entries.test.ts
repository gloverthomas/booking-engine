import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, timeEntry } from "@/db/schema";
import { clockIn } from "@/server/timesheets/clock";
import { approveEntries, createManualEntry, editEntry } from "@/server/timesheets/entries";
import { TimesheetError } from "@/server/timesheets/errors";
import { createStaff, seedBasics } from "../helpers/factories";
import { createTestDb } from "../helpers/test-db";
import "../reports/timeouts";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedBasics>>;
const manager = "staff:mgr-1" as const;
const owner = "owner:own-1" as const;
const NOW = () => new Date("2026-11-20T06:00:00Z");
const d = (iso: string) => new Date(iso);

beforeAll(async () => {
  t = await createTestDb();
  seed = await seedBasics(t.db);
});
afterAll(async () => {
  await t.client.close();
});

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TimesheetError);
  return (error as TimesheetError).code;
}

const base = (staffId: string) => ({
  staffId,
  clockIn: d("2026-11-16T22:00:00Z"),
  clockOut: d("2026-11-17T06:00:00Z"),
  reason: "Forgot to clock in",
  actor: manager,
});

describe("createManualEntry", () => {
  test("creates a finished manual entry and audits the reason", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "m1@example.com" });
    const row = await createManualEntry(
      t.db,
      { ...base(person.id), breakMinutes: 30, locationId: seed.loc.id, note: " busy day " },
      NOW,
    );
    expect(row.source).toBe("manual");
    expect(row.note).toBe("busy day");
    expect(row.approvedAt).toBeNull();
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, row.id));
    expect(audit.action).toBe("timesheet.manual_entry");
    expect(audit.data).toMatchObject({ reason: "Forgot to clock in" });
  });

  test("a reason is required", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "m2@example.com" });
    expect(await code(createManualEntry(t.db, { ...base(person.id), reason: "  " }, NOW))).toBe(
      "reason_required",
    );
  });

  test("rejects backwards, future, too long and silly-break entries", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "m3@example.com" });
    const b = base(person.id);
    expect(await code(createManualEntry(t.db, { ...b, clockOut: b.clockIn }, NOW))).toBe(
      "clock_out_before_in",
    );
    expect(
      await code(
        createManualEntry(
          t.db,
          { ...b, clockIn: d("2026-11-21T00:00:00Z"), clockOut: d("2026-11-21T01:00:00Z") },
          NOW,
        ),
      ),
    ).toBe("in_future");
    expect(
      await code(
        createManualEntry(
          t.db,
          { ...b, clockIn: d("2026-11-19T00:00:00Z"), clockOut: d("2026-11-20T05:00:00Z") },
          NOW,
        ),
      ),
    ).toBe("too_long");
    expect(
      await code(
        createManualEntry(
          t.db,
          { ...b, clockIn: d("2026-11-20T04:00:00Z"), clockOut: d("2026-11-20T08:00:00Z") },
          NOW,
        ),
      ),
    ).toBe("in_future");
    expect(await code(createManualEntry(t.db, { ...b, breakMinutes: 9999 }, NOW))).toBe(
      "bad_break",
    );
    expect(await code(createManualEntry(t.db, { ...b, breakMinutes: 600 }, NOW))).toBe("bad_break");
  });

  test("rejects overlap with another entry, including an open one", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "m4@example.com" });
    await createManualEntry(t.db, base(person.id), NOW);
    expect(
      await code(
        createManualEntry(
          t.db,
          {
            ...base(person.id),
            clockIn: d("2026-11-17T05:00:00Z"),
            clockOut: d("2026-11-17T08:00:00Z"),
          },
          NOW,
        ),
      ),
    ).toBe("overlap");
    // Touching end to start is fine.
    await expect(
      createManualEntry(
        t.db,
        {
          ...base(person.id),
          clockIn: d("2026-11-17T06:00:00Z"),
          clockOut: d("2026-11-17T08:00:00Z"),
        },
        NOW,
      ),
    ).resolves.toBeDefined();

    await clockIn(t.db, { staffId: person.id, actor: manager }, () => d("2026-11-19T22:00:00Z"));
    expect(
      await code(
        createManualEntry(
          t.db,
          {
            ...base(person.id),
            clockIn: d("2026-11-19T23:00:00Z"),
            clockOut: d("2026-11-20T01:00:00Z"),
          },
          NOW,
        ),
      ),
    ).toBe("overlap");
  });

  test("unknown person or location", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "m5@example.com" });
    expect(
      await code(createManualEntry(t.db, base("00000000-0000-4000-8000-000000000000"), NOW)),
    ).toBe("unknown_staff");
    expect(
      await code(
        createManualEntry(
          t.db,
          { ...base(person.id), locationId: "00000000-0000-4000-8000-000000000000" },
          NOW,
        ),
      ),
    ).toBe("unknown_location");
  });
});

describe("editEntry", () => {
  test("changes the entry, records before and after with the reason, and clears approval", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "e1@example.com" });
    const entry = await createManualEntry(t.db, base(person.id), NOW);
    await approveEntries(t.db, { entryIds: [entry.id], actor: owner }, NOW);

    const edited = await editEntry(
      t.db,
      {
        entryId: entry.id,
        clockOut: d("2026-11-17T05:30:00Z"),
        breakMinutes: 45,
        note: null,
        locationId: seed.loc.id,
        reason: "Left early",
        actor: manager,
      },
      NOW,
    );
    expect(edited.clockOut?.toISOString()).toBe("2026-11-17T05:30:00.000Z");
    expect(edited.breakMinutes).toBe(45);
    expect(edited.locationId).toBe(seed.loc.id);
    expect(edited.approvedAt).toBeNull();
    expect(edited.approvedBy).toBeNull();

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, entry.id));
    const audit = audits.find((a) => a.action === "timesheet.entry_edited");
    expect(audit?.data).toMatchObject({
      reason: "Left early",
      before: { approved: true, breakMinutes: 0 },
      after: { approved: false, breakMinutes: 45 },
    });
  });

  test("needs a reason, an existing entry, and must stay valid and non-overlapping", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "e2@example.com" });
    const first = await createManualEntry(t.db, base(person.id), NOW);
    const second = await createManualEntry(
      t.db,
      {
        ...base(person.id),
        clockIn: d("2026-11-17T10:00:00Z"),
        clockOut: d("2026-11-17T18:00:00Z"),
      },
      NOW,
    );
    expect(
      await code(editEntry(t.db, { entryId: first.id, reason: "", actor: manager }, NOW)),
    ).toBe("reason_required");
    expect(
      await code(
        editEntry(
          t.db,
          { entryId: "00000000-0000-4000-8000-000000000000", reason: "typo", actor: manager },
          NOW,
        ),
      ),
    ).toBe("not_found");
    expect(
      await code(
        editEntry(
          t.db,
          {
            entryId: first.id,
            clockOut: d("2026-11-16T21:00:00Z"),
            reason: "typo",
            actor: manager,
          },
          NOW,
        ),
      ),
    ).toBe("clock_out_before_in");
    expect(
      await code(
        editEntry(
          t.db,
          {
            entryId: second.id,
            clockIn: d("2026-11-17T05:00:00Z"),
            reason: "typo",
            actor: manager,
          },
          NOW,
        ),
      ),
    ).toBe("overlap");
    expect(
      await code(
        editEntry(
          t.db,
          {
            entryId: first.id,
            locationId: "00000000-0000-4000-8000-000000000000",
            reason: "typo",
            actor: manager,
          },
          NOW,
        ),
      ),
    ).toBe("unknown_location");
  });

  test("closing an open entry through an edit works", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "e3@example.com" });
    const open = await clockIn(t.db, { staffId: person.id, actor: manager }, () =>
      d("2026-11-19T22:00:00Z"),
    );
    const closed = await editEntry(
      t.db,
      {
        entryId: open.id,
        clockOut: d("2026-11-20T05:00:00Z"),
        reason: "Forgot to clock out",
        actor: manager,
      },
      NOW,
    );
    expect(closed.clockOut).not.toBeNull();
  });
});

describe("approveEntries", () => {
  test("approves finished entries once, skips open ones, and audits each", async () => {
    const person = await createStaff(t.db, seed.biz.id, { email: "a1@example.com" });
    const done = await createManualEntry(t.db, base(person.id), NOW);
    const open = await clockIn(t.db, { staffId: person.id, actor: manager }, () =>
      d("2026-11-19T22:00:00Z"),
    );

    const first = await approveEntries(
      t.db,
      { entryIds: [done.id, open.id, done.id], actor: owner },
      NOW,
    );
    expect(first).toEqual({ approved: 1, skippedOpen: 1, skippedOwn: 0, alreadyApproved: 0 });
    const [row] = await t.db.select().from(timeEntry).where(eq(timeEntry.id, done.id));
    expect(row.approvedAt?.toISOString()).toBe("2026-11-20T06:00:00.000Z");
    expect(row.approvedBy).toBe(owner);

    const again = await approveEntries(t.db, { entryIds: [done.id], actor: owner }, NOW);
    expect(again.alreadyApproved).toBe(1);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, done.id));
    expect(audits.filter((a) => a.action === "timesheet.entry_approved")).toHaveLength(1);
  });

  test("a manager cannot approve their own hours, an owner can", async () => {
    const person = await createStaff(t.db, seed.biz.id, {
      email: "a2@example.com",
      role: "manager",
    });
    const entry = await createManualEntry(t.db, base(person.id), NOW);
    const blocked = await approveEntries(
      t.db,
      { entryIds: [entry.id], actor: manager, approverStaffId: person.id },
      NOW,
    );
    expect(blocked.skippedOwn).toBe(1);
    const allowed = await approveEntries(
      t.db,
      { entryIds: [entry.id], actor: owner, approverStaffId: person.id },
      NOW,
    );
    expect(allowed.approved).toBe(1);
  });

  test("empty list is a no-op and an unknown id is an error", async () => {
    expect(await approveEntries(t.db, { entryIds: [], actor: owner }, NOW)).toMatchObject({
      approved: 0,
    });
    expect(
      await code(
        approveEntries(
          t.db,
          { entryIds: ["00000000-0000-4000-8000-000000000000"], actor: owner },
          NOW,
        ),
      ),
    ).toBe("not_found");
  });
});
