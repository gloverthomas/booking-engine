"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import { runImportAction } from "@/app/(admin)/import/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import type { ImportKind, ImportReport } from "@/server/import";
import { ColumnMapping, UnmappedNames } from "./Mapping";
import { ReportView } from "./ReportView";
import { DEFAULT_OPTIONS, toRequestOptions, type Choice, type WizardOptions } from "./labels";

interface Props {
  staff: readonly Choice[];
  locations: readonly Choice[];
}

interface Draft {
  kind: ImportKind;
  csv: string;
  mapping: Record<string, string | null>;
  options: WizardOptions;
}

/** Upload, check (a dry run that writes nothing), then confirm. Every change re-checks. */
export function ImportWizard({ staff, locations }: Props) {
  const [kind, setKind] = useState<ImportKind>("clients");
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();

  function send(next: Draft, dryRun: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await runImportAction({
        kind: next.kind,
        csv: next.csv,
        mapping: next.mapping,
        options: toRequestOptions(next.options),
        dryRun,
      });
      if (!result.ok || !result.data) {
        setError(result.ok ? "Nothing came back. Please try again." : result.error);
        return;
      }
      if (dryRun) {
        setReport(result.data);
        setConfirmed(false);
      } else {
        setDone(result.data);
        setReport(null);
      }
    });
  }

  function update(patch: Partial<Draft>) {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    send(next, true);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const csv = await file.text();
    const next: Draft = { kind, csv, mapping: {}, options: DEFAULT_OPTIONS };
    setFileName(file.name);
    setDraft(next);
    setDone(null);
    setReport(null);
    send(next, true);
  }

  function reset() {
    setDraft(null);
    setReport(null);
    setDone(null);
    setFileName(null);
    setError(null);
  }

  const importable = report ? report.summary.create + report.summary.link : 0;
  const options = draft?.options ?? DEFAULT_OPTIONS;

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Import finished</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <Alert tone={done.applied?.failed ? "warning" : "success"}>
            {done.applied?.created ?? 0} added
            {done.applied?.linked ? `, ${done.applied.linked} matched to existing clients` : ""}
            {done.applied?.failed ? `, ${done.applied.failed} could not be saved` : ""}. Nothing was
            sent to any client.
          </Alert>
          <ReportView report={done} />
          <div>
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>1. Choose a file</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <Select
            label="What is in the file?"
            value={kind}
            disabled={pending}
            onChange={(e) => {
              setKind(e.target.value as ImportKind);
              reset();
            }}
            hint="Do clients first, then appointments, so appointments attach to the right person."
          >
            <option value="clients">Clients (contacts)</option>
            <option value="appointments">Appointments</option>
          </Select>
          <label className="flex flex-col gap-2 text-sm font-semibold">
            CSV file exported from Timely
            <input
              key={kind}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={pending}
              className="block w-full rounded-control border border-line-strong bg-surface p-2 text-[0.9375rem] font-normal"
            />
          </label>
          {fileName ? <p className="text-sm text-ink-subtle">Loaded {fileName}</p> : null}
        </CardBody>
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {pending && !report ? <p role="status">Checking the file…</p> : null}

      {report && draft ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>2. Check the columns</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <p className="text-sm text-ink-subtle">
                We matched your file&rsquo;s columns automatically. Change any that look wrong; the
                result below updates each time.
              </p>
              <ColumnMapping
                report={report}
                onChange={(field, header) =>
                  update({ mapping: { ...draft.mapping, [field]: header } })
                }
              />
            </CardBody>
          </Card>

          {report.kind === "appointments" ? (
            <Card>
              <CardHeader>
                <CardTitle>3. Appointment settings</CardTitle>
              </CardHeader>
              <CardBody className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    label="Stylist when the file has none"
                    value={options.defaultStaffId}
                    onChange={(e) =>
                      update({ options: { ...options, defaultStaffId: e.target.value } })
                    }
                  >
                    <option value="">No default</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="Location when the file has none"
                    value={options.defaultLocationId}
                    onChange={(e) =>
                      update({ options: { ...options, defaultLocationId: e.target.value } })
                    }
                  >
                    <option value="">No default</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <UnmappedNames
                  report={report}
                  staff={staff}
                  locations={locations}
                  options={options}
                  onChange={(next) => update({ options: next })}
                />
                <Checkbox
                  label="Include past appointments as history"
                  checked={options.includePast}
                  onChange={(e) =>
                    update({ options: { ...options, includePast: e.target.checked } })
                  }
                />
                <Checkbox
                  label="Include cancelled appointments"
                  checked={options.includeCancelled}
                  onChange={(e) =>
                    update({ options: { ...options, includeCancelled: e.target.checked } })
                  }
                />
                <Checkbox
                  label="Record the unpaid balance of completed appointments as paid"
                  hint="Only needed if you want old takings to show in reports. Nothing is ever sent to Xero for imported bookings."
                  checked={options.recordBalance}
                  onChange={(e) =>
                    update({ options: { ...options, recordBalance: e.target.checked } })
                  }
                />
                <Checkbox
                  label="Send the usual day-before reminder for upcoming appointments"
                  hint="Off by default. Imported clients never get a booking confirmation, because they already have one from Timely."
                  checked={options.sendReminders}
                  onChange={(e) =>
                    update({ options: { ...options, sendReminders: e.target.checked } })
                  }
                />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{report.kind === "appointments" ? "4" : "3"}. Review and import</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
              <ReportView report={report} />
              <Checkbox
                label={`I have checked this and want to import ${importable.toLocaleString("en-AU")} ${
                  report.kind === "clients" ? "clients" : "appointments"
                }`}
                checked={confirmed}
                disabled={importable === 0 || pending}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <div>
                <Button
                  disabled={!confirmed || importable === 0 || pending}
                  onClick={() => send(draft, false)}
                >
                  {pending ? "Working…" : `Import ${importable.toLocaleString("en-AU")} now`}
                </Button>
              </div>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
