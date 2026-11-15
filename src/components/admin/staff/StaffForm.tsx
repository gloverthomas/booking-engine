"use client";

import { useState, type FormEvent } from "react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { createStaffAction, updateStaffAction } from "@/app/(admin)/staff/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { StaffRole } from "@/server/contracts";
import { ROLE_HINTS, ROLE_LABELS } from "@/server/staff/schemas";
import { assignableRoles } from "./rules";
import type { StaffRowView } from "./types";

const DEFAULT_COLOUR = "#d33a1e";

interface Props {
  viewerRole: StaffRole;
  /** The person being edited; null to add someone new. */
  person: StaffRowView | null;
  onDone: () => void;
}

/** Add / edit form, shown inside a sheet. */
export function StaffForm({ viewerRole, person, onDone }: Props) {
  const { pending, error, fieldErrors, submit } = useSubmit();
  const [v, setV] = useState({
    name: person?.name ?? "",
    email: person?.email ?? "",
    phone: person?.phone ?? "",
    role: person?.role ?? ("stylist" as StaffRole),
    level: String(person?.level ?? 0),
    autoColour: !person?.colour,
    colour: person?.colour ?? DEFAULT_COLOUR,
  });

  function set<K extends keyof typeof v>(key: K, value: (typeof v)[K]) {
    setV((current) => ({ ...current, [key]: value }));
  }

  const roles = assignableRoles(viewerRole);
  const levelNumber = v.level.trim() === "" ? Number.NaN : Number(v.level);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = {
      name: v.name,
      email: v.email,
      phone: v.phone,
      role: v.role,
      level: Number.isFinite(levelNumber) ? levelNumber : undefined,
      colour: v.autoColour ? "" : v.colour,
    };
    submit(
      async () => {
        const result = person
          ? await updateStaffAction({ ...payload, id: person.id })
          : await createStaffAction(payload);
        return result.ok ? { ok: true as const } : result;
      },
      {
        success: person ? "Changes saved" : "Team member added",
        onSuccess: onDone,
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {person ? null : (
        <Alert tone="info">
          They sign in with this Google email. There is no password and nothing to email them: tell
          them to open the admin and choose &ldquo;Continue with Google&rdquo;.
        </Alert>
      )}
      <Input
        label="Name"
        value={v.name}
        onChange={(e) => set("name", e.target.value)}
        error={fieldErrors.name}
        autoComplete="off"
      />
      <Input
        label="Google email"
        type="email"
        inputMode="email"
        value={v.email}
        onChange={(e) => set("email", e.target.value)}
        error={fieldErrors.email}
        hint="The Google account they sign in with. Must be unique across the team."
        autoComplete="off"
      />
      <Input
        label="Phone"
        type="tel"
        inputMode="tel"
        value={v.phone}
        onChange={(e) => set("phone", e.target.value)}
        error={fieldErrors.phone}
        hint="Optional. Used for text alerts about their bookings."
        autoComplete="off"
      />
      <Select
        label="Role"
        value={v.role}
        onChange={(e) => set("role", e.target.value as StaffRole)}
        error={fieldErrors.role}
        hint={ROLE_HINTS[v.role]}
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABELS[role]}
          </option>
        ))}
      </Select>
      <Input
        label="Level"
        type="number"
        inputMode="numeric"
        min={0}
        max={20}
        value={v.level}
        onChange={(e) => set("level", e.target.value)}
        error={fieldErrors.level}
        hint="Seniority tier for per-level pricing. 0 is the standard price list."
      />
      <Switch
        label="Pick a calendar colour automatically"
        checked={v.autoColour}
        onChange={(e) => set("autoColour", e.target.checked)}
      />
      {v.autoColour ? null : (
        <Input
          label="Calendar colour"
          type="color"
          value={v.colour}
          onChange={(e) => set("colour", e.target.value)}
          error={fieldErrors.colour}
          className="h-12 cursor-pointer p-1"
        />
      )}
      <Button type="submit" loading={pending}>
        {person ? "Save changes" : "Add to team"}
      </Button>
    </form>
  );
}
