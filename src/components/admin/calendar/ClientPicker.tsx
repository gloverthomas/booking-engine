"use client";

import { useState } from "react";
import type { ClientSummary } from "@/server/admin/types";
import { Badge, Button, Field, Input } from "./ui-shim";
import { useClientSearch } from "./useClientSearch";

export interface NewClientDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

export type ClientChoice =
  { kind: "existing"; client: ClientSummary } | { kind: "new"; draft: NewClientDraft };

const EMPTY_DRAFT: NewClientDraft = { firstName: "", lastName: "", phone: "", email: "" };

export function ClientPicker({
  value,
  onChange,
}: {
  value: ClientChoice | null;
  onChange: (next: ClientChoice | null) => void;
}) {
  const [query, setQuery] = useState("");
  const picking = value === null;
  const { results, searching, error: searchError } = useClientSearch(query, picking);

  if (value?.kind === "existing") {
    const c = value.client;
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-stone-100 p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{c.name}</p>
            <p className="text-sm text-stone-600">{c.phone ?? c.email ?? "No contact details"}</p>
          </div>
          <Button variant="ghost" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
        {c.blocked ? (
          <p role="alert" className="text-sm font-medium text-red-800">
            This client is blocked from online booking. Check before you book them in.
          </p>
        ) : null}
      </div>
    );
  }

  if (value?.kind === "new") {
    const update = (patch: Partial<NewClientDraft>) =>
      onChange({ kind: "new", draft: { ...value.draft, ...patch } });
    return (
      <div className="flex flex-col gap-3 rounded-xl bg-stone-100 p-3">
        <div className="flex items-center justify-between">
          <p className="font-semibold">New client</p>
          <Button variant="ghost" onClick={() => onChange(null)}>
            Search instead
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            {(id) => (
              <Input
                id={id}
                autoComplete="off"
                value={value.draft.firstName}
                onChange={(e) => update({ firstName: e.target.value })}
              />
            )}
          </Field>
          <Field label="Last name">
            {(id) => (
              <Input
                id={id}
                autoComplete="off"
                value={value.draft.lastName}
                onChange={(e) => update({ lastName: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label="Mobile" hint="Used for SMS reminders.">
          {(id) => (
            <Input
              id={id}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={value.draft.phone}
              onChange={(e) => update({ phone: e.target.value })}
            />
          )}
        </Field>
        <Field label="Email (optional)">
          {(id) => (
            <Input
              id={id}
              type="email"
              inputMode="email"
              autoComplete="off"
              value={value.draft.email}
              onChange={(e) => update({ email: e.target.value })}
            />
          )}
        </Field>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Field label="Client">
        {(id) => (
          <Input
            id={id}
            type="search"
            placeholder="Search name, phone or email"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </Field>
      {searchError ? (
        <p role="alert" className="text-sm text-red-800">
          {searchError}
        </p>
      ) : null}
      <ul
        className="flex max-h-56 flex-col overflow-y-auto rounded-xl border border-stone-200"
        aria-busy={searching}
      >
        {results.map((c) => (
          <li key={c.id} className="border-b border-stone-100 last:border-b-0">
            <button
              type="button"
              onClick={() => onChange({ kind: "existing", client: c })}
              className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-stone-100"
            >
              <span>
                <span className="block text-sm font-medium">{c.name}</span>
                <span className="block text-xs text-stone-500">{c.phone ?? c.email ?? ""}</span>
              </span>
              <span className="flex gap-1">
                {c.isVip ? <Badge tone="info">VIP</Badge> : null}
                {c.blocked ? <Badge tone="bad">Blocked</Badge> : null}
              </span>
            </button>
          </li>
        ))}
        {!searching && results.length === 0 ? (
          <li className="px-3 py-3 text-sm text-stone-500">No clients found.</li>
        ) : null}
      </ul>
      <Button
        variant="secondary"
        onClick={() => onChange({ kind: "new", draft: { ...EMPTY_DRAFT } })}
      >
        New client
      </Button>
    </div>
  );
}
