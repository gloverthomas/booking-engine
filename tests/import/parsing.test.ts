import { describe, expect, test } from "vitest";
import { parseCsv } from "@/server/import/csv";
import { autoMapAppointments, autoMapClients } from "@/server/import/fields";
import {
  parseBool,
  parseLocalDateTime,
  parseMinutes,
  parseMoneyCents,
  parseStatus,
  splitName,
} from "@/server/import/values";

const ZONE = "Australia/Melbourne";

describe("parseCsv", () => {
  test("reads headers and rows, trimming cells", () => {
    const { headers, records } = parseCsv("Name,Email\n Sam Client ,sam@example.com\n");
    expect(headers).toEqual(["Name", "Email"]);
    expect(records).toEqual([{ Name: "Sam Client", Email: "sam@example.com" }]);
  });

  test("handles quotes, escaped quotes, commas and newlines inside quotes, CRLF and a BOM", () => {
    const text = '﻿Name,Notes\r\n"Lee, Jo","Said ""hi""\nand left"\r\nAl,\r\n';
    const { records } = parseCsv(text);
    expect(records).toEqual([
      { Name: "Lee, Jo", Notes: 'Said "hi"\nand left' },
      { Name: "Al", Notes: "" },
    ]);
  });

  test("detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2").records[0]).toEqual({ a: "1", b: "2" });
    expect(parseCsv("a\tb\n1\t2").records[0]).toEqual({ a: "1", b: "2" });
  });

  test("renames duplicate and blank headers, drops blank lines, pads short rows", () => {
    const { headers, records } = parseCsv("Phone,Phone,\n\n1,2,3\n4\n");
    expect(headers).toEqual(["Phone", "Phone (2)", "Column 3"]);
    expect(records).toEqual([
      { Phone: "1", "Phone (2)": "2", "Column 3": "3" },
      { Phone: "4", "Phone (2)": "", "Column 3": "" },
    ]);
  });

  test("an empty file has no headers", () => {
    expect(parseCsv("")).toEqual({ headers: [], records: [] });
  });
});

describe("autoMap", () => {
  test("maps common client headers, giving ids and emails priority over the generic name", () => {
    const map = autoMapClients([
      "Customer ID",
      "Name",
      "Email Address",
      "Mobile",
      "Notes",
      "Marketing",
    ]);
    expect(map).toMatchObject({
      ref: "Customer ID",
      fullName: "Name",
      email: "Email Address",
      phone: "Mobile",
      notes: "Notes",
      marketingOptIn: "Marketing",
      firstName: null,
    });
  });

  test("prefers first and last name columns and never reuses a header", () => {
    const map = autoMapClients(["First Name", "Last Name", "Email"]);
    expect(map.firstName).toBe("First Name");
    expect(map.lastName).toBe("Last Name");
    expect(map.fullName).toBeNull();
  });

  test("maps appointment headers", () => {
    const map = autoMapAppointments([
      "Appointment ID",
      "Customer",
      "Customer Email",
      "Service",
      "Staff",
      "Date",
      "Start Time",
      "Duration",
      "Status",
      "Price",
      "Deposit",
    ]);
    expect(map).toMatchObject({
      ref: "Appointment ID",
      clientName: "Customer",
      clientEmail: "Customer Email",
      service: "Service",
      staff: "Staff",
      date: "Date",
      startTime: "Start Time",
      duration: "Duration",
      status: "Status",
      price: "Price",
      deposit: "Deposit",
    });
  });
});

describe("value parsers", () => {
  test.each([
    ["$95.00", 9500],
    ["95", 9500],
    ["1,250.50", 125050],
    ["(12.00)", -1200],
    ["-5", -500],
  ])("money %s", (raw, cents) => expect(parseMoneyCents(raw)).toBe(cents));
  test.each(["", "free", "$"])("money rejects %j", (raw) =>
    expect(parseMoneyCents(raw)).toBeNull(),
  );
  expect(parseMoneyCents(undefined)).toBeNull();

  test.each([
    ["Yes", true],
    ["opted in", true],
    ["No", false],
    ["Unsubscribed", false],
    ["maybe", null],
    ["", null],
  ])("bool %s", (raw, expected) => expect(parseBool(raw)).toBe(expected));

  test.each([
    ["45", 45],
    ["45 mins", 45],
    ["1h 30m", 90],
    ["2 hours", 120],
    ["1:30", 90],
    ["90 minutes", 90],
  ])("minutes %s", (raw, mins) => expect(parseMinutes(raw)).toBe(mins));
  test.each(["", "soon"])("minutes rejects %j", (raw) => expect(parseMinutes(raw)).toBeNull());

  test.each([
    ["Booked", "booked"],
    ["Confirmed", "booked"],
    ["Completed", "completed"],
    ["Paid", "completed"],
    ["Cancelled", "cancelled"],
    ["No Show", "no_show"],
    ["did not attend", "no_show"],
    ["", "unknown"],
    ["weird", "unknown"],
  ])("status %s", (raw, kind) => expect(parseStatus(raw)).toBe(kind));

  test("splits names on the first space", () => {
    expect(splitName("Sam")).toEqual({ firstName: "Sam", lastName: "" });
    expect(splitName("Sam van der Berg")).toEqual({ firstName: "Sam", lastName: "van der Berg" });
  });
});

describe("parseLocalDateTime (Melbourne)", () => {
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  test.each([
    ["24/11/2026", "2:30 PM", "2026-11-24T03:30:00.000Z"],
    ["24/11/2026", "2:30pm", "2026-11-24T03:30:00.000Z"],
    ["24/11/2026", "14:30", "2026-11-24T03:30:00.000Z"],
    ["2026-11-24", "09:00", "2026-11-23T22:00:00.000Z"],
    ["24 Nov 2026", "9:00 AM", "2026-11-23T22:00:00.000Z"],
    ["Tue 24 Nov 2026", "9am", "2026-11-23T22:00:00.000Z"],
  ])("%s %s", (date, time, expected) =>
    expect(iso(parseLocalDateTime(date, time, ZONE))).toBe(expected),
  );

  test("reads combined date-times and ISO strings", () => {
    expect(iso(parseLocalDateTime("24/11/2026 2:30 PM", null, ZONE))).toBe(
      "2026-11-24T03:30:00.000Z",
    );
    expect(iso(parseLocalDateTime("2026-11-24T14:30:00", null, ZONE))).toBe(
      "2026-11-24T03:30:00.000Z",
    );
  });

  test("a date alone is local midnight; nonsense is null", () => {
    expect(iso(parseLocalDateTime("24/11/2026", null, ZONE))).toBe("2026-11-23T13:00:00.000Z");
    expect(parseLocalDateTime("someday", "later", ZONE)).toBeNull();
    expect(parseLocalDateTime("", "9:00", ZONE)).toBeNull();
  });

  test("is day-first: 03/04/2026 is 3 April", () => {
    expect(iso(parseLocalDateTime("03/04/2026", "10:00", ZONE))).toBe("2026-04-02T23:00:00.000Z");
  });
});
