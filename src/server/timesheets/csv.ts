import { DateTime } from "luxon";
import { toCsv, type CsvColumn } from "../reports/csv";
import { minutesToHours } from "./time";
import type { TimesheetEntryView, WeeklyTimesheet } from "./weekly";

interface SummaryRow {
  staff: string;
  weekStart: string;
  workedHours: number;
  rosteredHours: number;
  differenceHours: number;
  breakMinutes: number;
  pendingEntries: number;
  approvedEntries: number;
}

interface EntryRow {
  staff: string;
  date: string;
  clockIn: string;
  clockOut: string;
  breakMinutes: number;
  workedHours: number;
  location: string;
  source: string;
  status: string;
  note: string;
}

const SUMMARY_COLUMNS: readonly CsvColumn<SummaryRow>[] = [
  { key: "staff", header: "Staff" },
  { key: "weekStart", header: "Week starting" },
  { key: "workedHours", header: "Worked hours", type: "decimal" },
  { key: "rosteredHours", header: "Rostered hours", type: "decimal" },
  { key: "differenceHours", header: "Difference hours", type: "decimal" },
  { key: "breakMinutes", header: "Break minutes", type: "int" },
  { key: "pendingEntries", header: "Entries awaiting approval", type: "int" },
  { key: "approvedEntries", header: "Entries approved", type: "int" },
];

const ENTRY_COLUMNS: readonly CsvColumn<EntryRow>[] = [
  { key: "staff", header: "Staff" },
  { key: "date", header: "Date" },
  { key: "clockIn", header: "Clock in" },
  { key: "clockOut", header: "Clock out" },
  { key: "breakMinutes", header: "Break minutes", type: "int" },
  { key: "workedHours", header: "Worked hours", type: "decimal" },
  { key: "location", header: "Location" },
  { key: "source", header: "Source" },
  { key: "status", header: "Status" },
  { key: "note", header: "Note" },
];

const STATUS_LABEL = {
  open: "Clocked in",
  pending: "Awaiting approval",
  approved: "Approved",
} as const;

/** One row per person: worked, rostered and difference as decimal hours (real numbers in the sheet). */
export function summaryCsv(sheets: readonly WeeklyTimesheet[]): string {
  const rows: SummaryRow[] = sheets.map((s) => ({
    staff: s.staffName,
    weekStart: s.weekStart,
    workedHours: minutesToHours(s.workedMinutes),
    rosteredHours: minutesToHours(s.rosteredMinutes),
    differenceHours: minutesToHours(s.differenceMinutes),
    breakMinutes: s.breakMinutes,
    pendingEntries: s.pendingCount,
    approvedEntries: s.approvedCount,
  }));
  return toCsv(SUMMARY_COLUMNS, rows);
}

function entryRow(name: string, e: TimesheetEntryView, timezone: string): EntryRow {
  const local = (d: Date) => DateTime.fromJSDate(d, { zone: timezone }).toFormat("HH:mm");
  return {
    staff: name,
    date: e.date,
    clockIn: local(e.clockIn),
    clockOut: e.clockOut ? local(e.clockOut) : "",
    breakMinutes: e.breakMinutes,
    workedHours: minutesToHours(e.netMinutes),
    location: e.locationName ?? "",
    source: e.source === "manual" ? "Manual" : "Clock",
    status: STATUS_LABEL[e.status],
    note: e.note ?? "",
  };
}

/** One row per time entry. Notes are free text, so anything a spreadsheet could run as a formula is neutralised. */
export function entriesCsv(sheets: readonly WeeklyTimesheet[], timezone: string): string {
  const rows = sheets.flatMap((s) =>
    s.days.flatMap((d) => d.entries.map((e) => entryRow(s.staffName, e, timezone))),
  );
  return toCsv(ENTRY_COLUMNS, rows);
}
