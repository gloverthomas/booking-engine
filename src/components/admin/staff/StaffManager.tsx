"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { setStaffActiveAction } from "@/app/(admin)/staff/actions";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import type { StaffRole } from "@/server/contracts";
import { ROLE_LABELS } from "@/server/staff/schemas";
import { GoogleCalendarControl } from "./GoogleCalendarControl";
import { canManageRow } from "./rules";
import { StaffForm } from "./StaffForm";
import type { StaffRowView } from "./types";

const ROLE_TONE: Record<StaffRole, BadgeTone> = {
  owner: "peach",
  manager: "info",
  stylist: "neutral",
  reception: "neutral",
};

interface Props {
  people: readonly StaffRowView[];
  viewerRole: StaffRole;
  googleConfigured: boolean;
}

type Editing = { kind: "new" } | { kind: "edit"; person: StaffRowView } | null;

export function StaffManager({ people, viewerRole, googleConfigured }: Props) {
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<StaffRowView | null>(null);
  const { pending, error, submit, clearErrors } = useSubmit();

  const active = people.filter((p) => p.active);
  const inactive = people.filter((p) => !p.active);

  function setActive(person: StaffRowView, nextActive: boolean) {
    submit(() => setStaffActiveAction({ id: person.id, active: nextActive }), {
      success: nextActive ? `${person.name} reactivated` : `${person.name} deactivated`,
      onSuccess: () => setConfirming(null),
    });
  }

  function closeConfirm() {
    clearErrors();
    setConfirming(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button onClick={() => setEditing({ kind: "new" })}>
          <Plus aria-hidden className="size-4" />
          Add team member
        </Button>
      </div>

      {error && !confirming ? <Alert tone="danger">{error}</Alert> : null}

      {active.length === 0 ? (
        <EmptyState
          title="No one on the team yet"
          description="Add the people who work here. Each signs in with their own Google account."
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {active.map((person) => (
            <li key={person.id} className="flex">
              <PersonCard
                person={person}
                viewerRole={viewerRole}
                googleConfigured={googleConfigured}
                onEdit={() => setEditing({ kind: "edit", person })}
                onDeactivate={() => setConfirming(person)}
                onReactivate={() => setActive(person, true)}
              />
            </li>
          ))}
        </ul>
      )}

      {inactive.length > 0 ? (
        <section aria-labelledby="staff-inactive" className="flex flex-col gap-3">
          <h2 id="staff-inactive" className="eyebrow">
            Deactivated
          </h2>
          <ul className="grid gap-4 lg:grid-cols-2">
            {inactive.map((person) => (
              <li key={person.id} className="flex">
                <PersonCard
                  person={person}
                  viewerRole={viewerRole}
                  googleConfigured={googleConfigured}
                  onEdit={() => setEditing({ kind: "edit", person })}
                  onDeactivate={() => setConfirming(person)}
                  onReactivate={() => setActive(person, true)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        side="right"
        title={editing?.kind === "edit" ? `Edit ${editing.person.name}` : "Add team member"}
      >
        {editing ? (
          <StaffForm
            // A fresh form (and state) for each person.
            key={editing.kind === "edit" ? editing.person.id : "new"}
            viewerRole={viewerRole}
            person={editing.kind === "edit" ? editing.person : null}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>

      <Dialog
        open={confirming !== null}
        onClose={closeConfirm}
        title={confirming ? `Deactivate ${confirming.name}?` : "Deactivate"}
        description="They are signed out and can't sign in again until you reactivate them. Their past bookings and history stay."
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() => confirming && setActive(confirming, false)}
            >
              Deactivate
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </Dialog>
    </div>
  );
}

interface PersonCardProps {
  person: StaffRowView;
  viewerRole: StaffRole;
  googleConfigured: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}

function PersonCard({
  person,
  viewerRole,
  googleConfigured,
  onEdit,
  onDeactivate,
  onReactivate,
}: PersonCardProps) {
  const mayManage = canManageRow(viewerRole, person.role);
  return (
    <Card aria-labelledby={`staff-${person.id}`} className="flex w-full flex-col">
      <CardBody className="flex flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="mt-1.5 size-3 shrink-0 rounded-pill border border-ink"
              style={{ backgroundColor: person.colour ?? "transparent" }}
            />
            <div className="min-w-0">
              <h3 id={`staff-${person.id}`} className="text-lg font-bold leading-tight">
                {person.name}
              </h3>
              <p className="truncate text-sm text-ink-muted">{person.email ?? "No email"}</p>
              {person.phone ? <p className="text-sm text-ink-muted">{person.phone}</p> : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={ROLE_TONE[person.role]}>{ROLE_LABELS[person.role]}</Badge>
            {person.active ? null : <Badge tone="warning">Deactivated</Badge>}
          </div>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-subtle">Level</dt>
          <dd>{person.level}</dd>
          <dt className="text-ink-subtle">Signed in</dt>
          <dd>{person.hasSignedIn ? "Yes" : "Not yet"}</dd>
        </dl>

        {person.active ? (
          <GoogleCalendarControl
            staffId={person.id}
            google={person.google}
            configured={googleConfigured}
          />
        ) : null}

        <div className="mt-auto flex flex-wrap gap-2">
          {mayManage ? (
            <>
              <Button variant="secondary" size="sm" onClick={onEdit}>
                Edit
              </Button>
              {person.active ? (
                <Button variant="ghost" size="sm" onClick={onDeactivate}>
                  Deactivate
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={onReactivate}>
                  Reactivate
                </Button>
              )}
            </>
          ) : (
            <p className="text-xs text-ink-subtle">Only an owner can change an owner.</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
