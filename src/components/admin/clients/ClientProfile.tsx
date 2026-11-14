"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  mergeClientsAction,
  setClientBlockedAction,
  setClientVipAction,
  updateClientNotesAction,
} from "@/app/(admin)/clients/actions";
import { BookingSheet } from "@/components/admin/calendar/BookingSheet";
import { callAction } from "@/components/admin/calendar/api";
import {
  STATUS_LABEL,
  STATUS_TONE,
  formatDateTime,
  formatMoney,
} from "@/components/admin/calendar/format";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Switch,
  Textarea,
  ToastProvider,
  useToast,
} from "@/components/admin/calendar/ui-shim";
import { useClientSearch } from "@/components/admin/calendar/useClientSearch";
import type { ClientProfile as ClientProfileData, ClientSummary } from "@/server/admin/types";

export function ClientProfile(props: { profile: ClientProfileData; timezone: string }) {
  return (
    <ToastProvider>
      <ProfileBody {...props} />
    </ToastProvider>
  );
}

function ProfileBody({ profile, timezone }: { profile: ClientProfileData; timezone: string }) {
  const router = useRouter();
  const toast = useToast();
  const [notes, setNotes] = useState(profile.notes ?? "");
  const [savedNotes, setSavedNotes] = useState(profile.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [isVip, setIsVip] = useState(profile.isVip);
  const [blocked, setBlocked] = useState(profile.blocked);
  const [openBooking, setOpenBooking] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const closeBooking = useCallback(() => setOpenBooking(null), []);
  const refresh = useCallback(() => router.refresh(), [router]);

  async function saveNotes() {
    setSavingNotes(true);
    const result = await callAction(() => updateClientNotesAction({ clientId: profile.id, notes }));
    setSavingNotes(false);
    if (!result.ok) {
      toast({ tone: "error", title: "Notes not saved", description: result.error });
      return;
    }
    setSavedNotes(notes.trim());
    toast({ tone: "success", title: "Notes saved" });
  }

  /** Optimistic toggle: flip now, roll back with an error toast if the server refuses. */
  async function toggle(
    next: boolean,
    set: (value: boolean) => void,
    previous: boolean,
    run: () => ReturnType<typeof setClientVipAction>,
    failure: string,
  ) {
    set(next);
    const result = await callAction(run);
    if (!result.ok) {
      set(previous);
      toast({ tone: "error", title: failure, description: result.error });
    }
  }

  const { stats } = profile;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-3 md:p-6">
      <nav aria-label="Breadcrumb">
        <Link
          href="/clients"
          className="inline-flex min-h-11 items-center text-sm text-stone-600 underline-offset-2 hover:underline"
        >
          &lsaquo; All clients
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{profile.name}</h1>
          {isVip ? <Badge tone="info">VIP</Badge> : null}
          {blocked ? <Badge tone="bad">Blocked</Badge> : null}
        </div>
        <div className="flex flex-col text-sm text-stone-700">
          {profile.phone ? (
            <a href={`tel:${profile.phone}`} className="inline-flex min-h-11 items-center">
              {profile.phone}
            </a>
          ) : null}
          {profile.email ? (
            <a href={`mailto:${profile.email}`} className="inline-flex min-h-11 items-center">
              {profile.email}
            </a>
          ) : null}
          {profile.pronouns ? <span>{profile.pronouns}</span> : null}
        </div>
      </header>

      <section aria-label="Summary">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Visits" value={String(stats.completedCount)} />
          <Stat label="Lifetime spend" value={formatMoney(stats.lifetimeSpendCents)} />
          <Stat label="Upcoming" value={String(stats.upcomingCount)} />
          <Stat
            label="No-shows"
            value={String(stats.noShowCount)}
            tone={stats.noShowCount > 0 ? "bad" : undefined}
          />
          <Stat
            label="Late cancels"
            value={String(stats.lateCancelCount)}
            tone={stats.lateCancelCount > 0 ? "bad" : undefined}
          />
          <Stat label="Cancelled" value={String(stats.cancelledCount)} />
        </dl>
      </section>

      <Card className="flex flex-col gap-3">
        <Field
          label="Notes"
          hint="Cut formula, preferences, anything worth remembering. Only you can see this."
        >
          {(id) => (
            <Textarea
              id={id}
              value={notes}
              maxLength={4000}
              rows={5}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
        <Button
          loading={savingNotes}
          disabled={notes.trim() === savedNotes.trim()}
          onClick={() => void saveNotes()}
        >
          Save notes
        </Button>
      </Card>

      <Card className="flex flex-col">
        <Switch
          checked={isVip}
          label="VIP"
          description="Can book VIP-only services."
          onChange={(next) =>
            void toggle(
              next,
              setIsVip,
              isVip,
              () => setClientVipAction({ clientId: profile.id, isVip: next }),
              "VIP status not changed",
            )
          }
        />
        <Switch
          checked={blocked}
          label="Blocked"
          description="Cannot book online. You can still book them in yourself."
          onChange={(next) =>
            void toggle(
              next,
              setBlocked,
              blocked,
              () => setClientBlockedAction({ clientId: profile.id, blocked: next }),
              "Blocked status not changed",
            )
          }
        />
      </Card>

      <section className="flex flex-col gap-2" aria-labelledby="history-heading">
        <h2
          id="history-heading"
          className="text-sm font-semibold uppercase tracking-wide text-stone-500"
        >
          History
        </h2>
        {profile.history.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">
            No bookings yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {profile.history.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setOpenBooking(row.id)}
                  className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-left hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-stone-900"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{formatDateTime(row.start, timezone)}</span>
                    <span className="block truncate text-sm text-stone-600">
                      {row.services.join(", ") || "No services"} · {row.locationName}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm font-medium">{formatMoney(row.totalCents)}</span>
                    <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="flex flex-col gap-2 border-t border-stone-200 pt-4"
        aria-labelledby="merge-heading"
      >
        <h2
          id="merge-heading"
          className="text-sm font-semibold uppercase tracking-wide text-stone-500"
        >
          Duplicate record?
        </h2>
        <p className="text-sm text-stone-600">
          If this person is in your list twice, merge the other record into this one.
        </p>
        <Button variant="secondary" onClick={() => setMergeOpen(true)}>
          Merge a duplicate into {profile.firstName}
        </Button>
      </section>

      <BookingSheet
        bookingId={openBooking}
        timezone={timezone}
        onClose={closeBooking}
        onChanged={refresh}
      />

      <MergeDialog
        open={mergeOpen}
        keep={{ id: profile.id, name: profile.name }}
        onClose={() => setMergeOpen(false)}
        onMerged={() => {
          setMergeOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <Card className="flex flex-col gap-0.5 p-3">
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd
        className={tone === "bad" ? "text-xl font-semibold text-red-800" : "text-xl font-semibold"}
      >
        {value}
      </dd>
    </Card>
  );
}

function MergeDialog({
  open,
  keep,
  onClose,
  onMerged,
}: {
  open: boolean;
  keep: { id: string; name: string };
  onClose: () => void;
  onMerged: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Merge duplicate">
      {open ? <MergeForm keep={keep} onClose={onClose} onMerged={onMerged} /> : null}
    </Dialog>
  );
}

function MergeForm({
  keep,
  onClose,
  onMerged,
}: {
  keep: { id: string; name: string };
  onClose: () => void;
  onMerged: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [duplicate, setDuplicate] = useState<ClientSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const { results, searching, error } = useClientSearch(query, duplicate === null);

  async function merge() {
    if (!duplicate) return;
    setBusy(true);
    const result = await callAction(() =>
      mergeClientsAction({ keepClientId: keep.id, duplicateClientId: duplicate.id }),
    );
    setBusy(false);
    if (!result.ok) {
      toast({ tone: "error", title: "Merge did not work", description: result.error });
      return;
    }
    toast({ tone: "success", title: "Records merged" });
    onMerged();
  }

  if (duplicate) {
    return (
      <>
        <p className="text-sm text-stone-700">
          Merge <strong>{duplicate.name}</strong> into <strong>{keep.name}</strong>? Their bookings
          and payments move to {keep.name}, and {duplicate.name} disappears from your client list.
          This cannot be undone.
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy}
            onClick={() => setDuplicate(null)}
          >
            Back
          </Button>
          <Button variant="danger" className="flex-1" loading={busy} onClick={() => void merge()}>
            Merge
          </Button>
        </div>
      </>
    );
  }

  const candidates = results.filter((c) => c.id !== keep.id);
  return (
    <>
      <Field label="Find the duplicate">
        {(id) => (
          <Input
            id={id}
            type="search"
            autoComplete="off"
            placeholder="Search name, phone or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <ul
        className="flex max-h-60 flex-col overflow-y-auto rounded-xl border border-stone-200"
        aria-busy={searching}
      >
        {candidates.map((c) => (
          <li key={c.id} className="border-b border-stone-100 last:border-b-0">
            <button
              type="button"
              onClick={() => setDuplicate(c)}
              className="flex min-h-11 w-full flex-col px-3 py-2 text-left hover:bg-stone-100"
            >
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-stone-500">{c.phone ?? c.email ?? ""}</span>
            </button>
          </li>
        ))}
        {!searching && candidates.length === 0 ? (
          <li className="px-3 py-3 text-sm text-stone-500">No other clients found.</li>
        ) : null}
      </ul>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
    </>
  );
}
