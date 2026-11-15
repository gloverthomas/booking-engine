import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  auditLog,
  booking,
  bookingService,
  client,
  domainEvent,
  messageLog,
  payment,
} from "@/db/schema";
import {
  importRequestSchema,
  runImport,
  type ImportReport,
  type ImportRequest,
} from "@/server/import";
import { addBooking, addStaff, createWorld, local, NOW, type World } from "../availability/setup";

let w: World;

beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.t.client.close();
});

const request = (
  kind: ImportRequest["kind"],
  csv: string,
  extra: Omit<Partial<z.input<typeof importRequestSchema>>, "kind" | "csv"> = {},
): ImportRequest => importRequestSchema.parse({ kind, csv, dryRun: false, ...extra });

const run = (req: ImportRequest): Promise<ImportReport> =>
  runImport(w.db, req, { actor: "mcp", clock: () => NOW });

const CLIENTS = [
  "Customer ID,First Name,Last Name,Email,Mobile,Notes,Marketing",
  "101,Jo,Lee,jo@example.com,0412 345 678,Likes a fringe,Yes",
  "102,Pat,Kim,PAT@example.com,0423 456 789,,No",
  "103,Sam,Client,sam@example.com,,,",
  "104,,,,,,",
  "105,Bad,Email,not-an-email,0499,,",
].join("\n");

describe("clients", () => {
  test("a dry run reports the plan and writes nothing", async () => {
    const report = await run(request("clients", CLIENTS, { dryRun: true }));
    expect(report.dryRun).toBe(true);
    expect(report.applied).toBeNull();
    expect(report.summary).toMatchObject({ total: 5, create: 3, link: 1, skip: 1 });
    expect(await w.db.select().from(client)).toHaveLength(1);
    expect(await w.db.select().from(auditLog)).toHaveLength(0);
    expect(report.preview).toHaveLength(5);
    expect(report.mapping.email).toBe("Email");
  });

  test("applies: creates clients, links an existing one by email, keeps its details", async () => {
    const report = await run(request("clients", CLIENTS));
    expect(report.applied).toEqual({ created: 3, linked: 1, failed: 0 });

    const jo = (await w.db.select().from(client).where(eq(client.externalRef, "timely:101")))[0];
    expect(jo).toMatchObject({
      firstName: "Jo",
      lastName: "Lee",
      phone: "+61412345678",
      notes: "Likes a fringe",
      marketingOptIn: true,
    });
    const pat = (await w.db.select().from(client).where(eq(client.externalRef, "timely:102")))[0];
    expect(pat).toMatchObject({ email: "pat@example.com", marketingOptIn: false });

    const sam = (await w.db.select().from(client).where(eq(client.id, w.clientId)))[0];
    expect(sam.externalRef).toBe("timely:103");
    expect(sam.firstName).toBe("Sam");

    const bad = (await w.db.select().from(client).where(eq(client.externalRef, "timely:105")))[0];
    expect(bad).toMatchObject({ email: null, phone: null });

    expect(report.issues.filter((i) => i.level === "error").map((i) => i.row)).toEqual([5]);
    expect(report.issues.some((i) => i.message.includes("invalid email"))).toBe(true);
  });

  test("is idempotent: running the same file again changes nothing", async () => {
    await run(request("clients", CLIENTS));
    const again = await run(request("clients", CLIENTS));
    expect(again.summary).toMatchObject({ create: 0, link: 0, unchanged: 4 });
    expect(again.applied).toEqual({ created: 0, linked: 0, failed: 0 });
    expect(await w.db.select().from(client)).toHaveLength(4);
  });

  test("two rows for the same person become one client", async () => {
    const csv = ["Name,Email", "Dana Fox,dana@example.com", "Dana Fox,Dana@Example.com"].join("\n");
    const report = await run(request("clients", csv));
    expect(report.applied?.created).toBe(1);
    expect(report.issues[0].message).toContain("Same person as row 2");
  });

  test("a single full-name column is split", async () => {
    await run(request("clients", "Name,Phone\nRiley van Dyke,0411 111 111"));
    const row = (await w.db.select().from(client).where(eq(client.phone, "+61411111111")))[0];
    expect(row).toMatchObject({ firstName: "Riley", lastName: "van Dyke" });
  });

  test("an explicit mapping overrides detection", async () => {
    const csv = "Who,Contact\nAlex Chen,alex@example.com";
    const report = await run(
      request("clients", csv, { mapping: { fullName: "Who", email: "Contact" } }),
    );
    expect(report.applied?.created).toBe(1);
    expect(
      await w.db.select().from(client).where(eq(client.email, "alex@example.com")),
    ).toHaveLength(1);
  });

  test("never contacts anyone", async () => {
    await run(request("clients", CLIENTS));
    expect(await w.db.select().from(messageLog)).toHaveLength(0);
    expect(await w.db.select().from(domainEvent)).toHaveLength(0);
  });

  test("rejects an empty or oversized request", async () => {
    await expect(run(request("clients", "\n\n"))).rejects.toThrow("no header");
    expect(() => importRequestSchema.parse({ kind: "clients", csv: "" })).toThrow();
  });
});

const APPTS_HEADER =
  "Appointment ID,Customer,Customer Email,Service,Staff,Date,Start Time,Duration,Status,Price,Deposit,Notes";

const appts = (...rows: string[]) => [APPTS_HEADER, ...rows].join("\n");

describe("appointments", () => {
  const FUTURE =
    "10001,Sam Client,sam@example.com,Maintenance Haircut,Ryan,02/11/2026,10:00 AM,45,Booked,$95.00,$47.50,Bring photo";
  const FUTURE_NEW =
    "10002,Jo Lee,jo@example.com,Colour Refresh,Ryan,03/11/2026,1:00 PM,90,Booked,$180.00,$90.00,";
  const PAST =
    "10003,Jo Lee,jo@example.com,Maintenance Haircut,Ryan,20/10/2026,9:00 AM,45,Completed,$95.00,$0,";

  test("a dry run plans without writing", async () => {
    const report = await run(
      request("appointments", appts(FUTURE, FUTURE_NEW, PAST), { dryRun: true }),
    );
    expect(report.summary).toMatchObject({ total: 3, create: 3, errors: 0 });
    expect(await w.db.select().from(booking)).toHaveLength(0);
    expect(report.unmapped.services).toEqual([
      { key: "colour refresh", name: "Colour Refresh", rows: 1 },
    ]);
  });

  test("creates bookings, service snapshots and legacy deposit payments", async () => {
    const report = await run(request("appointments", appts(FUTURE, FUTURE_NEW, PAST)));
    expect(report.applied).toEqual({ created: 3, linked: 0, failed: 0 });

    const first = (
      await w.db.select().from(booking).where(eq(booking.externalRef, "timely:10001"))
    )[0];
    expect(first).toMatchObject({
      status: "confirmed",
      clientId: w.clientId,
      staffId: w.staffId,
      locationId: w.locationId,
      source: "import:timely",
      totalCents: 9500,
      depositCents: 4750,
      comments: "Bring photo",
    });
    expect(first.during).toEqual({
      start: local("2026-11-02T10:00"),
      end: local("2026-11-02T10:45"),
    });

    const lines = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, first.id));
    expect(lines).toEqual([
      expect.objectContaining({
        serviceId: w.haircutId,
        name: "Maintenance Haircut",
        durationMin: 45,
        priceCents: 9500,
      }),
    ]);

    const [deposit] = await w.db.select().from(payment).where(eq(payment.bookingId, first.id));
    expect(deposit).toMatchObject({
      kind: "deposit",
      method: "other",
      status: "succeeded",
      amountCents: 4750,
      metadata: { legacy: true, importedFrom: "timely:10001" },
    });
  });

  test("an unknown service is kept as text with the file's price and duration", async () => {
    await run(request("appointments", appts(FUTURE_NEW)));
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:10002")))[0];
    const [line] = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, b.id));
    expect(line).toMatchObject({
      serviceId: null,
      name: "Colour Refresh",
      durationMin: 90,
      priceCents: 18000,
    });
    expect(b.totalCents).toBe(18000);
  });

  test("a past booked appointment is history (completed); a past one can be left out", async () => {
    const pastBooked =
      "10004,Sam Client,sam@example.com,Maintenance Haircut,Ryan,15/10/2026,9:00 AM,45,Booked,$95,,";
    await run(request("appointments", appts(pastBooked)));
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:10004")))[0];
    expect(b.status).toBe("completed");

    const skipped = await run(
      request("appointments", appts(PAST), { options: { includePast: false } }),
    );
    expect(skipped.applied?.created).toBe(0);
  });

  test("a new client is created once for several appointments", async () => {
    const a =
      "20001,Kai Ng,kai@example.com,Maintenance Haircut,Ryan,04/11/2026,9:00 AM,45,Booked,$95,,";
    const b =
      "20002,Kai Ng,kai@example.com,Maintenance Haircut,Ryan,11/11/2026,9:00 AM,45,Booked,$95,,";
    await run(request("appointments", appts(a, b)));
    expect(
      await w.db.select().from(client).where(eq(client.email, "kai@example.com")),
    ).toHaveLength(1);
  });

  test("links appointments to clients imported earlier by their id", async () => {
    await run(request("clients", CLIENTS));
    const csv = [
      "Appointment ID,Customer ID,Service,Staff,Start,Duration,Status,Price",
      "30001,101,Maintenance Haircut,Ryan,05/11/2026 9:00 AM,45,Booked,$95",
    ].join("\n");
    await run(request("appointments", csv));
    const jo = (await w.db.select().from(client).where(eq(client.externalRef, "timely:101")))[0];
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:30001")))[0];
    expect(b.clientId).toBe(jo.id);
  });

  test("is idempotent", async () => {
    await run(request("appointments", appts(FUTURE, FUTURE_NEW, PAST)));
    const again = await run(request("appointments", appts(FUTURE, FUTURE_NEW, PAST)));
    expect(again.summary).toMatchObject({ create: 0, unchanged: 3 });
    expect(await w.db.select().from(booking)).toHaveLength(3);
    expect(await w.db.select().from(payment)).toHaveLength(2);
  });

  test("rows without an id get a stable one, so re-importing does not duplicate", async () => {
    const csv = [
      "Customer,Email,Service,Staff,Date,Time,Duration,Status,Price",
      "Sam Client,sam@example.com,Maintenance Haircut,Ryan,06/11/2026,9:00 AM,45,Booked,$95",
    ].join("\n");
    await run(request("appointments", csv));
    const again = await run(request("appointments", csv));
    expect(again.summary.unchanged).toBe(1);
    expect(await w.db.select().from(booking)).toHaveLength(1);
  });

  test("an overlap with an existing booking is reported and the other rows still import", async () => {
    await addBooking(w.db, w, local("2026-11-02T10:15"), local("2026-11-02T11:00"));
    const report = await run(request("appointments", appts(FUTURE, FUTURE_NEW)));
    expect(report.applied).toEqual({ created: 1, linked: 0, failed: 0 });
    expect(report.issues).toEqual([
      expect.objectContaining({
        row: 2,
        level: "error",
        message: expect.stringContaining("Overlaps"),
      }),
    ]);
  });

  test("two overlapping rows in the same file: the second is rejected", async () => {
    const clash =
      "10099,Jo Lee,jo@example.com,Maintenance Haircut,Ryan,02/11/2026,10:30 AM,45,Booked,$95,,";
    const report = await run(request("appointments", appts(FUTURE, clash)));
    expect(report.summary.errors).toBe(1);
    expect(report.applied?.created).toBe(1);
  });

  test("the database constraint is the backstop when the plan went stale", async () => {
    const dry = await run(request("appointments", appts(FUTURE), { dryRun: true }));
    expect(dry.summary.errors).toBe(0);
    await addBooking(w.db, w, local("2026-11-02T10:00"), local("2026-11-02T10:45"));
    const report = await run(request("appointments", appts(FUTURE)));
    expect(report.summary.errors).toBe(1);
    expect(report.applied?.created).toBe(0);
    // The failed row left no stray client or booking behind.
    expect(await w.db.select().from(booking)).toHaveLength(1);
  });

  test("a failed row does not leave a client for later rows to point at", async () => {
    await addBooking(w.db, w, local("2026-11-02T09:00"), local("2026-11-02T12:00"));
    const failing =
      "40001,Nia Bell,nia@example.com,Maintenance Haircut,Ryan,02/11/2026,10:00 AM,45,Booked,$95,,";
    const later =
      "40002,Nia Bell,nia@example.com,Maintenance Haircut,Ryan,09/11/2026,10:00 AM,45,Booked,$95,,";
    // Plan against an empty calendar, then block it so row 1 fails at apply time.
    const dry = await run(request("appointments", appts(failing, later), { dryRun: true }));
    expect(dry.summary.errors).toBe(1);
    const report = await run(request("appointments", appts(later)));
    expect(report.applied?.created).toBe(1);
    expect(
      await w.db.select().from(client).where(eq(client.email, "nia@example.com")),
    ).toHaveLength(1);
  });

  test("an unknown stylist is an error until it is mapped or a default is chosen", async () => {
    const row =
      "50001,Sam Client,sam@example.com,Maintenance Haircut,Jordan,07/11/2026,9:00 AM,45,Booked,$95,,";
    const first = await run(request("appointments", appts(row), { dryRun: true }));
    expect(first.unmapped.staff).toEqual([{ key: "jordan", name: "Jordan", rows: 1 }]);
    expect(first.summary.errors).toBe(1);

    const jordan = await addStaff(w.db, w.businessId, "Jordan Fox");
    const auto = await run(request("appointments", appts(row), { dryRun: true }));
    expect(auto.summary.errors).toBe(0);

    const mapped = await run(
      request("appointments", appts(row), { options: { staffMap: { jordan: w.staffId } } }),
    );
    expect(mapped.applied?.created).toBe(1);
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:50001")))[0];
    expect(b.staffId).toBe(w.staffId);
    expect(jordan.id).not.toBe(w.staffId);
  });

  test("a default stylist and location cover blank columns", async () => {
    const csv = [
      "Appointment ID,Customer,Customer Email,Service,Date,Time,Duration,Status,Price",
      "60001,Sam Client,sam@example.com,Maintenance Haircut,08/11/2026,9:00 AM,45,Booked,$95",
    ].join("\n");
    const noDefault = await run(request("appointments", csv, { dryRun: true }));
    expect(noDefault.issues[0].message).toContain("No stylist");
    const ok = await run(request("appointments", csv, { options: { defaultStaffId: w.staffId } }));
    expect(ok.applied?.created).toBe(1);
  });

  test("cancelled and no-show appointments", async () => {
    const cancelled =
      "70001,Sam Client,sam@example.com,Maintenance Haircut,Ryan,09/11/2026,9:00 AM,45,Cancelled,$95,$47.50,";
    const noShow =
      "70002,Sam Client,sam@example.com,Maintenance Haircut,Ryan,10/10/2026,9:00 AM,45,No Show,$95,$47.50,";
    const left = await run(request("appointments", appts(cancelled, noShow)));
    expect(left.applied?.created).toBe(1);
    const kept = await run(
      request("appointments", appts(cancelled, noShow), { options: { includeCancelled: true } }),
    );
    expect(kept.applied?.created).toBe(1);
    const c = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:70001")))[0];
    expect(c).toMatchObject({
      status: "cancelled_by_staff",
      cancelReason: "Imported as cancelled",
    });
    expect(c.cancelledAt).toEqual(NOW);
    const n = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:70002")))[0];
    expect(n.status).toBe("no_show");
  });

  test("a cancelled booking does not block the slot", async () => {
    const cancelled =
      "70010,Sam Client,sam@example.com,Maintenance Haircut,Ryan,09/11/2026,9:00 AM,45,Cancelled,$95,,";
    const rebooked =
      "70011,Jo Lee,jo@example.com,Maintenance Haircut,Ryan,09/11/2026,9:00 AM,45,Booked,$95,,";
    const report = await run(
      request("appointments", appts(cancelled, rebooked), { options: { includeCancelled: true } }),
    );
    expect(report.applied).toEqual({ created: 2, linked: 0, failed: 0 });
  });

  test("optionally records the unpaid balance of completed bookings", async () => {
    await run(request("appointments", appts(PAST), { options: { recordBalance: true } }));
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:10003")))[0];
    const pays = await w.db.select().from(payment).where(eq(payment.bookingId, b.id));
    expect(pays).toEqual([
      expect.objectContaining({ kind: "balance", amountCents: 9500, method: "other" }),
    ]);
  });

  test("multiple services in one cell become separate lines that sum to the total", async () => {
    const csv = appts(
      "80001,Sam Client,sam@example.com,Maintenance Haircut + Toner,Ryan,12/11/2026,9:00 AM,75,Booked,$140,,",
    );
    await run(request("appointments", csv));
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:80001")))[0];
    const lines = await w.db
      .select()
      .from(bookingService)
      .where(eq(bookingService.bookingId, b.id));
    expect(lines.map((l) => l.name)).toEqual(["Maintenance Haircut", "Toner"]);
    expect(lines.reduce((s, l) => s + l.priceCents, 0)).toBe(14000);
    expect(lines.reduce((s, l) => s + l.durationMin, 0)).toBe(75);
    expect(b.during.end.getTime() - b.during.start.getTime()).toBe(75 * 60_000);
  });

  test("reads the end time from an end column", async () => {
    const csv = [
      "Appointment ID,Customer,Customer Email,Service,Staff,Date,Start Time,End Time,Status,Price",
      "90001,Sam Client,sam@example.com,Maintenance Haircut,Ryan,13/11/2026,9:00 AM,10:30 AM,Booked,$95",
    ].join("\n");
    await run(request("appointments", csv));
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:90001")))[0];
    expect(b.during.end).toEqual(local("2026-11-13T10:30"));
  });

  test("bad rows are reported by row number and skipped", async () => {
    const report = await run(
      request(
        "appointments",
        appts(
          "1,Sam Client,sam@example.com,Maintenance Haircut,Ryan,not a date,9:00 AM,45,Booked,$95,,",
          "2,,,Maintenance Haircut,Ryan,14/11/2026,9:00 AM,45,Booked,$95,,",
          "3,Sam Client,sam@example.com,Maintenance Haircut,Ryan,14/11/2026,9:00 AM,9999,Booked,$95,,",
          "4,Sam Client,sam@example.com,Maintenance Haircut,Ryan,14/11/2026,9:00 AM,45,Booked,$95,,",
        ),
      ),
    );
    expect(report.issues.map((i) => i.row)).toEqual([2, 3, 4]);
    expect(report.applied?.created).toBe(1);
  });
});

describe("side effects", () => {
  const FUTURE =
    "10001,Sam Client,sam@example.com,Maintenance Haircut,Ryan,02/11/2026,10:00 AM,45,Booked,$95.00,$47.50,";
  const PAST =
    "10003,Sam Client,sam@example.com,Maintenance Haircut,Ryan,20/10/2026,9:00 AM,45,Completed,$95.00,$0,";

  test("by default imports are silent: no events, no messages", async () => {
    await run(request("appointments", appts(FUTURE, PAST)));
    expect(await w.db.select().from(domainEvent)).toHaveLength(0);
    expect(await w.db.select().from(messageLog)).toHaveLength(0);
  });

  test("with reminders on, only future confirmed bookings get a reminder event", async () => {
    await run(request("appointments", appts(FUTURE, PAST), { options: { sendReminders: true } }));
    const events = await w.db.select().from(domainEvent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("booking.imported");
    const b = (await w.db.select().from(booking).where(eq(booking.externalRef, "timely:10001")))[0];
    expect(events[0].payload).toMatchObject({ bookingId: b.id });
  });

  test("records one audit entry per applied run, not for dry runs", async () => {
    await run(request("appointments", appts(FUTURE), { dryRun: true }));
    expect(await w.db.select().from(auditLog)).toHaveLength(0);
    await run(request("appointments", appts(FUTURE)));
    const [entry] = await w.db.select().from(auditLog);
    expect(entry).toMatchObject({ actor: "mcp", action: "import.run", entityType: "import" });
    expect(entry.data).toMatchObject({ kind: "appointments", created: 1 });
  });
});
