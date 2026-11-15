import { createHash } from "node:crypto";
import type { ColumnMap, ClientField } from "./fields";
import type { Catalog, ClientOp, ClientTarget, ClientValues, ImportIssue } from "./types";
import {
  normaliseName,
  normalizeEmail,
  normalizePhone,
  parseBool,
  parseLocalDateTime,
  splitName,
} from "./values";

export const refFor = (source: string, id: string) => `${source}:${id}`;

/** Stable id for rows that have none, so re-running an import never duplicates them. */
export const autoRef = (source: string, ...parts: string[]) =>
  refFor(`${source}:auto`, createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20));

const cell = (record: Record<string, string>, header: string | null) =>
  header ? (record[header] ?? "").trim() : "";

export interface IdentityInput {
  ref: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
}

export interface ResolvedIdentity {
  values: Pick<ClientValues, "firstName" | "lastName" | "email" | "phone">;
  warnings: string[];
  error: string | null;
}

/** Normalise the identity columns of a row (shared by the client and appointment importers). */
export function resolveIdentity(input: IdentityInput): ResolvedIdentity {
  const warnings: string[] = [];
  let { firstName, lastName } = input;
  if (!firstName && input.fullName) ({ firstName, lastName } = splitName(input.fullName));

  const email = input.email ? normalizeEmail(input.email) : null;
  if (input.email && !email) warnings.push(`Ignored invalid email "${input.email}"`);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) warnings.push(`Ignored invalid phone "${input.phone}"`);

  const error = firstName || lastName ? null : "No name";
  return {
    values: { firstName: firstName || lastName, lastName: firstName ? lastName : "", email, phone },
    warnings,
    error,
  };
}

type Existing = Catalog["clients"][number];

/** Lookup tables over the clients that already exist. */
export class ClientIndex {
  private readonly byRef = new Map<string, Existing>();
  private readonly byEmail = new Map<string, Existing>();
  private readonly byPhone = new Map<string, Existing>();
  private readonly byName = new Map<string, Existing[]>();

  constructor(clients: readonly Existing[]) {
    for (const c of clients) {
      if (c.externalRef) this.byRef.set(c.externalRef, c);
      if (c.email) this.byEmail.set(c.email.toLowerCase(), c);
      if (c.phone) this.byPhone.set(c.phone, c);
      const key = normaliseName(`${c.firstName} ${c.lastName}`);
      this.byName.set(key, [...(this.byName.get(key) ?? []), c]);
    }
  }

  find(ref: string | null, email: string | null, phone: string | null): Existing | undefined {
    return (
      (ref ? this.byRef.get(ref) : undefined) ??
      (email ? this.byEmail.get(email) : undefined) ??
      (phone ? this.byPhone.get(phone) : undefined)
    );
  }

  /** Only when exactly one client has this name, and only used when the row has no email or phone. */
  findByName(first: string, last: string): Existing | undefined {
    const matches = this.byName.get(normaliseName(`${first} ${last}`));
    return matches?.length === 1 ? matches[0] : undefined;
  }
}

/**
 * Clients created during one run (so two rows for the same person become one client). Used by both the
 * client importer and the appointment importer.
 */
export class Roster {
  private readonly keys = new Map<string, string>();
  private counter = 0;

  constructor(readonly index: ClientIndex) {}

  /** Resolve or register a person. `firstSeenRow` is set when this row is a repeat. */
  resolve(
    externalRef: string | null,
    values: ClientValues,
    row: number,
  ): { target: ClientTarget; existing: Existing | undefined; firstSeenRow?: number } {
    const existing = this.index.find(externalRef, values.email, values.phone);
    if (existing) return { target: { kind: "existing", id: existing.id }, existing };

    const identityKeys = [
      externalRef && `ref:${externalRef}`,
      values.email && `email:${values.email}`,
      values.phone && `phone:${values.phone}`,
    ].filter((k): k is string => Boolean(k));
    const byName =
      identityKeys.length === 0
        ? this.index.findByName(values.firstName, values.lastName)
        : undefined;
    if (byName) return { target: { kind: "existing", id: byName.id }, existing: byName };

    const nameKey = `name:${normaliseName(`${values.firstName} ${values.lastName}`)}`;
    const searchKeys = identityKeys.length > 0 ? identityKeys : [nameKey];
    for (const k of searchKeys) {
      const found = this.keys.get(k);
      if (found)
        return {
          target: this.targetFor(found, externalRef, values),
          existing: undefined,
          firstSeenRow: row,
        };
    }
    this.counter += 1;
    const key = `new:${this.counter}`;
    for (const k of searchKeys) this.keys.set(k, key);
    return { target: this.targetFor(key, externalRef, values), existing: undefined };
  }

  private targetFor(key: string, externalRef: string | null, values: ClientValues): ClientTarget {
    return { kind: "new", key, externalRef, values };
  }
}

export interface ClientPlan {
  ops: ClientOp[];
  issues: ImportIssue[];
}

export function planClients(
  records: ReadonlyArray<Record<string, string>>,
  map: ColumnMap<ClientField>,
  catalog: Catalog,
  source: string,
): ClientPlan {
  const roster = new Roster(new ClientIndex(catalog.clients));
  const seenRows = new Map<string, number>();
  const ops: ClientOp[] = [];
  const issues: ImportIssue[] = [];

  records.forEach((record, i) => {
    const row = i + 2;
    const idText = cell(record, map.ref);
    const externalRef = idText ? refFor(source, idText) : null;
    const identity = resolveIdentity({
      ref: idText,
      firstName: cell(record, map.firstName),
      lastName: cell(record, map.lastName),
      fullName: cell(record, map.fullName),
      email: cell(record, map.email),
      phone: cell(record, map.phone),
    });
    const values: ClientValues = {
      ...identity.values,
      notes: cell(record, map.notes) || null,
      marketingOptIn: parseBool(cell(record, map.marketingOptIn)) ?? false,
      blocked: parseBool(cell(record, map.blocked)) ?? false,
      createdAt: parseLocalDateTime(cell(record, map.createdAt), null, catalog.zone),
    };
    for (const message of identity.warnings) issues.push({ row, level: "warning", message });

    if (identity.error) {
      issues.push({ row, level: "error", message: `${identity.error}; row skipped` });
      ops.push({ row, action: "skip", externalRef, values });
      return;
    }

    const { target, existing, firstSeenRow } = roster.resolve(externalRef, values, row);
    if (firstSeenRow !== undefined && target.kind === "new") {
      const original = seenRows.get(target.key);
      issues.push({ row, level: "warning", message: `Same person as row ${original}; skipped` });
      ops.push({ row, action: "skip", externalRef, values });
      return;
    }
    if (target.kind === "new") {
      seenRows.set(target.key, row);
      ops.push({ row, action: "create", externalRef, values });
      return;
    }
    const alreadyLinked = existing?.externalRef === externalRef;
    ops.push({
      row,
      action: alreadyLinked || !externalRef || existing?.externalRef ? "unchanged" : "link",
      externalRef,
      existingId: target.id,
      values,
    });
  });

  return { ops, issues };
}
