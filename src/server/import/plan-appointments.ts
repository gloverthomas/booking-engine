import { DateTime } from "luxon";
import type { AppointmentField, ColumnMap } from "./fields";
import { autoRef, refFor, resolveIdentity, ClientIndex, Roster } from "./plan-clients";
import type {
  BookingLine,
  BookingOp,
  Catalog,
  ClientValues,
  ImportedBookingStatus,
  ImportIssue,
  ImportOptions,
  Unmapped,
} from "./types";
import {
  normaliseName,
  parseLocalDateTime,
  parseMinutes,
  parseMoneyCents,
  parseStatus,
} from "./values";

const FALLBACK_DURATION_MIN = 60;
const MAX_DURATION_MIN = 12 * 60;

const cell = (record: Record<string, string>, header: string | null) =>
  header ? (record[header] ?? "").trim() : "";

export interface AppointmentPlan {
  ops: BookingOp[];
  issues: ImportIssue[];
  unmapped: Unmapped;
}

class Tally {
  private readonly counts = new Map<string, { name: string; rows: number }>();
  add(name: string) {
    const key = normaliseName(name);
    const current = this.counts.get(key) ?? { name, rows: 0 };
    this.counts.set(key, { name: current.name, rows: current.rows + 1 });
  }
  list() {
    return [...this.counts.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.rows - a.rows);
  }
}

function matchByName<T extends { id: string; name: string }>(
  items: readonly T[],
  wanted: string,
): T | undefined {
  const key = normaliseName(wanted);
  const exact = items.find((i) => normaliseName(i.name) === key);
  if (exact) return exact;
  // "Ryan" matches "Ryan Kennedy" when it is the only one starting with that first name.
  const prefix = items.filter((i) => normaliseName(i.name).split(" ")[0] === key);
  return prefix.length === 1 ? prefix[0] : undefined;
}

/** "Cut + Colour" or "Cut; Colour": a whole-string match wins, otherwise split on ; | + only. */
function splitServices(raw: string, catalog: Catalog): string[] {
  if (!raw) return [];
  if (matchByName(catalog.services, raw)) return [raw];
  return raw
    .split(/\s*(?:;|\||\+)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveStatus(
  raw: ReturnType<typeof parseStatus>,
  start: Date,
  now: Date,
): ImportedBookingStatus {
  if (raw === "cancelled") return "cancelled_by_staff";
  if (raw === "no_show") return "no_show";
  if (raw === "completed") return "completed";
  return start.getTime() >= now.getTime() ? "confirmed" : "completed";
}

function buildLines(
  names: string[],
  options: ImportOptions,
  catalog: Catalog,
  totalDurationMin: number | null,
  totalCents: number | null,
  unmapped: Tally,
): BookingLine[] {
  const base = (names.length > 0 ? names : ["Imported appointment"]).map((name) => {
    const mapped = options.serviceMap[normaliseName(name)];
    const found =
      mapped !== undefined
        ? mapped === null
          ? undefined
          : catalog.services.find((s) => s.id === mapped)
        : matchByName(catalog.services, name);
    if (!found && mapped === undefined && names.length > 0) unmapped.add(name);
    return {
      serviceId: found?.id ?? null,
      name: found?.name ?? name,
      durationMin: found?.durationMin ?? 0,
      priceCents: found?.priceCents ?? 0,
    };
  });

  const known = base.reduce((sum, l) => sum + l.durationMin, 0);
  const wanted = totalDurationMin ?? (known > 0 ? known : FALLBACK_DURATION_MIN);
  const unknownCount = base.filter((l) => l.durationMin === 0).length;
  const spare = Math.max(wanted - known, 0);
  const lines = base.map((l, i) => ({
    ...l,
    durationMin:
      l.durationMin > 0
        ? l.durationMin
        : Math.max(
            Math.floor(spare / Math.max(unknownCount, 1)) +
              (i === 0 ? spare % Math.max(unknownCount, 1) : 0),
            1,
          ),
  }));

  // Put the whole difference between the file's total and the catalogue prices on the first line.
  if (totalCents !== null) {
    const sum = lines.reduce((s, l) => s + l.priceCents, 0);
    const first = lines[0];
    lines[0] = { ...first, priceCents: Math.max(first.priceCents + (totalCents - sum), 0) };
  }
  return lines;
}

export function planAppointments(
  records: ReadonlyArray<Record<string, string>>,
  map: ColumnMap<AppointmentField>,
  catalog: Catalog,
  options: ImportOptions,
  source: string,
): AppointmentPlan {
  const index = new ClientIndex(catalog.clients);
  const roster = new Roster(index);
  const issues: ImportIssue[] = [];
  const ops: BookingOp[] = [];
  const unmappedStaff = new Tally();
  const unmappedLocations = new Tally();
  const unmappedServices = new Tally();
  const seenRefs = new Set<string>();
  const held = [...catalog.heldBookings];

  const fail = (row: number, message: string) => {
    issues.push({ row, level: "error", message });
  };

  records.forEach((record, i) => {
    const row = i + 2;
    const start = ((): Date | null => {
      // Exports often hold the whole date-time in a single "Start" column, which auto-detection files under start time.
      const combined = cell(record, map.start) || (map.date ? "" : cell(record, map.startTime));
      if (combined) return parseLocalDateTime(combined, null, catalog.zone);
      return parseLocalDateTime(cell(record, map.date), cell(record, map.startTime), catalog.zone);
    })();
    if (!start) return fail(row, "Could not read the appointment date and time; row skipped");

    // Client
    const refText = cell(record, map.clientRef);
    const clientRef = refText ? refFor(source, refText) : null;
    const identity = resolveIdentity({
      ref: refText,
      firstName: cell(record, map.clientFirstName),
      lastName: cell(record, map.clientLastName),
      fullName: cell(record, map.clientName),
      email: cell(record, map.clientEmail),
      phone: cell(record, map.clientPhone),
    });
    // A client id that matches someone already in the system is enough; a name is only needed for new people.
    if (identity.error && !index.find(clientRef, null, null)) {
      return fail(row, "No client name and no matching client id; row skipped");
    }
    for (const message of identity.warnings) issues.push({ row, level: "warning", message });

    // Stylist and location
    const staffName = cell(record, map.staff);
    const staffKey = normaliseName(staffName);
    const staffId =
      (staffName && (options.staffMap[staffKey] ?? matchByName(catalog.staff, staffName)?.id)) ||
      options.defaultStaffId;
    if (!staffId) {
      if (staffName) unmappedStaff.add(staffName);
      return fail(
        row,
        staffName ? `Unknown stylist "${staffName}"` : "No stylist and no default chosen",
      );
    }
    const locationName = cell(record, map.location);
    const locationKey = normaliseName(locationName);
    const locationId =
      (locationName &&
        (options.locationMap[locationKey] ?? matchByName(catalog.locations, locationName)?.id)) ||
      options.defaultLocationId ||
      (catalog.locations.length === 1 ? catalog.locations[0].id : undefined);
    if (!locationId) {
      if (locationName) unmappedLocations.add(locationName);
      return fail(
        row,
        locationName ? `Unknown location "${locationName}"` : "No location and no default chosen",
      );
    }

    // Timing, money, status
    const statusKind = parseStatus(cell(record, map.status));
    const status = resolveStatus(statusKind, start, catalog.now);
    if (statusKind === "unknown" && cell(record, map.status)) {
      issues.push({
        row,
        level: "warning",
        message: `Unrecognised status "${cell(record, map.status)}"; treated as ${status === "confirmed" ? "booked" : "completed"}`,
      });
    }
    if (status === "cancelled_by_staff" && !options.includeCancelled) return;
    if (start < catalog.now && status !== "confirmed" && !options.includePast) return;

    const explicitEnd = ((): Date | null => {
      const full = cell(record, map.end) || (map.date ? "" : cell(record, map.endTime));
      if (full) {
        const parsed = parseLocalDateTime(full, null, catalog.zone);
        if (parsed) return parsed;
      }
      const timeOnly = cell(record, map.endTime);
      return timeOnly
        ? parseLocalDateTime(
            DateTime.fromJSDate(start, { zone: catalog.zone }).toFormat("yyyy-MM-dd"),
            timeOnly,
            catalog.zone,
          )
        : null;
    })();
    const durationMin =
      explicitEnd && explicitEnd > start
        ? Math.round((explicitEnd.getTime() - start.getTime()) / 60_000)
        : parseMinutes(cell(record, map.duration));
    if (explicitEnd && explicitEnd <= start)
      return fail(row, "End time is not after the start time; row skipped");
    if (durationMin !== null && (durationMin <= 0 || durationMin > MAX_DURATION_MIN)) {
      return fail(row, `Implausible duration (${durationMin} min); row skipped`);
    }

    const totalRaw = parseMoneyCents(cell(record, map.price));
    const totalCents = totalRaw !== null && totalRaw >= 0 ? totalRaw : null;
    const depositRaw = parseMoneyCents(cell(record, map.deposit)) ?? 0;
    const lines = buildLines(
      splitServices(cell(record, map.service), catalog),
      options,
      catalog,
      durationMin,
      totalCents,
      unmappedServices,
    );
    const lineDuration = lines.reduce((s, l) => s + l.durationMin, 0);
    const end =
      explicitEnd && explicitEnd > start
        ? explicitEnd
        : new Date(start.getTime() + lineDuration * 60_000);
    const total = lines.reduce((s, l) => s + l.priceCents, 0);
    const deposit = Math.min(Math.max(depositRaw, 0), total > 0 ? total : depositRaw);
    const balance =
      status === "completed" && options.recordBalance ? Math.max(total - deposit, 0) : 0;

    // Stable identity
    const idText = cell(record, map.ref);
    const externalRef = idText
      ? refFor(source, idText)
      : autoRef(
          source,
          clientRef ??
            identity.values.email ??
            identity.values.phone ??
            normaliseName(`${identity.values.firstName} ${identity.values.lastName}`),
          start.toISOString(),
          staffId,
        );
    if (seenRefs.has(externalRef)) {
      issues.push({
        row,
        level: "warning",
        message: "Duplicate of an earlier row in this file; skipped",
      });
      return;
    }
    seenRefs.add(externalRef);

    const values: ClientValues = {
      ...identity.values,
      notes: null,
      marketingOptIn: false,
      blocked: false,
      createdAt: null,
    };
    const { target } = roster.resolve(clientRef, values, row);

    const op: BookingOp = {
      row,
      action: catalog.bookingRefs.has(externalRef) ? "unchanged" : "create",
      externalRef,
      client: target,
      staffId,
      locationId,
      start,
      end,
      status,
      totalCents: total,
      depositCents: deposit,
      balanceCents: balance,
      lines,
      notes: cell(record, map.notes) || null,
    };

    if (op.action === "create" && status === "confirmed") {
      const clash = held.find((h) => h.staffId === staffId && h.start < end && start < h.end);
      if (clash) {
        fail(
          row,
          `Overlaps another booking for this stylist at ${DateTime.fromJSDate(clash.start, { zone: catalog.zone }).toFormat("d MMM h:mm a")}; row skipped`,
        );
        return;
      }
      held.push({ staffId, start, end });
    }
    ops.push(op);
  });

  return {
    ops,
    issues,
    unmapped: {
      staff: unmappedStaff.list(),
      locations: unmappedLocations.list(),
      services: unmappedServices.list(),
    },
  };
}
