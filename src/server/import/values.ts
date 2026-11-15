import { DateTime } from "luxon";
import { normalizeEmail, normalizePhone } from "../clients";

export { normalizeEmail, normalizePhone };

/** "$95.00", "95", "1,250.50", "(12.00)" -> cents. Null when empty or not a number. */
export function parseMoneyCents(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw.trim()) || raw.trim().startsWith("-");
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (cleaned === "" || Number.isNaN(Number(cleaned))) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return negative ? -cents : cents;
}

export function parseBool(raw: string | undefined | null): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (
    ["yes", "y", "true", "1", "opted in", "opt in", "subscribed", "accepted", "x", "on"].includes(v)
  )
    return true;
  if (["no", "n", "false", "0", "opted out", "unsubscribed", "declined", "off"].includes(v))
    return false;
  return null;
}

export function parseMinutes(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const hm = v.match(/^(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0);
  const colon = v.match(/^(\d+):(\d{2})(?::\d{2})?$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const plain = v.match(/^(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?)?$/);
  if (plain) return Math.round(Number(plain[1]));
  return null;
}

export type ImportStatus = "booked" | "completed" | "cancelled" | "no_show" | "unknown";

export function parseStatus(raw: string | undefined | null): ImportStatus {
  const v = raw?.trim().toLowerCase() ?? "";
  if (!v) return "unknown";
  if (/no[\s-]?show|did not attend|dna/.test(v)) return "no_show";
  if (/cancel|declin|void/.test(v)) return "cancelled";
  if (/complet|paid|done|finish|attended|checked out|invoiced/.test(v)) return "completed";
  if (/book|confirm|schedul|pending|arrived|upcoming|started|in progress/.test(v)) return "booked";
  return "unknown";
}

const DATE_FORMATS = [
  "d/M/yyyy",
  "dd/MM/yyyy",
  "d/M/yy",
  "dd/MM/yy",
  "d-M-yyyy",
  "dd-MM-yyyy",
  "d.M.yyyy",
  "yyyy-MM-dd",
  "yyyy/MM/dd",
  "d MMM yyyy",
  "dd MMM yyyy",
  "d MMMM yyyy",
  "dd MMMM yyyy",
  "EEE d MMM yyyy",
  "EEE, d MMM yyyy",
  "EEEE d MMMM yyyy",
  "EEEE, d MMMM yyyy",
  "EEE dd MMM yyyy",
];
const TIME_FORMATS = [
  "H:mm",
  "HH:mm",
  "H:mm:ss",
  "HH:mm:ss",
  "h:mm a",
  "h:mma",
  "hh:mm a",
  "h:mm:ss a",
  "h a",
  "ha",
  "h.mm a",
  "h.mma",
];

function clean(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase())
    .replace(/(\d)(am|pm)\b/gi, (_, d, m) => `${d}${m.toUpperCase()}`);
}

/** A local date (and optional time) in the business timezone, as an instant. Day-first, as in Australia. */
export function parseLocalDateTime(
  date: string | undefined | null,
  time: string | undefined | null,
  zone: string,
): Date | null {
  const d = date ? clean(date) : "";
  if (!d) return null;
  const t = time ? clean(time) : "";

  // A full ISO value ("2026-11-24T11:30:00", with or without an offset) carries everything.
  if (!t && /^\d{4}-\d{2}-\d{2}[T ]\d/.test(d)) {
    const iso = DateTime.fromISO(d.replace(" ", "T"), { zone });
    if (iso.isValid) return iso.toJSDate();
  }
  const candidates: string[] = [];
  if (t) {
    for (const df of DATE_FORMATS) for (const tf of TIME_FORMATS) candidates.push(`${df}|${tf}`);
  } else {
    for (const df of DATE_FORMATS) {
      for (const tf of TIME_FORMATS) candidates.push(`${df} ${tf}|`);
      candidates.push(`${df}|`);
    }
  }
  for (const c of candidates) {
    const [dateFmt, timeFmt] = c.split("|");
    const text = t ? `${d} ${t}` : d;
    const fmt = t ? `${dateFmt} ${timeFmt}` : dateFmt;
    const parsed = DateTime.fromFormat(text, fmt, { zone, locale: "en-AU" });
    if (parsed.isValid) return parsed.toJSDate();
  }
  return null;
}

/** Splits "Sam Client" into first and last name (everything after the first word is the last name). */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().replace(/\s+/g, " ").split(" ");
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export const normaliseName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
