import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ImportReport } from "@/server/import";

function Stat({ value, caption }: { value: number; caption: string }) {
  return (
    <div className="flex flex-col">
      <dd className="text-2xl font-semibold tabular-nums">{value.toLocaleString("en-AU")}</dd>
      <dt className="text-sm text-ink-subtle">{caption}</dt>
    </div>
  );
}

/** The numbers, then every problem by row, then a few rows as read so the mapping can be sanity-checked. */
export function ReportView({ report }: { report: ImportReport }) {
  const { summary, issues, issueCount, preview, headers } = report;
  const noun = report.kind === "clients" ? "clients" : "appointments";
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat value={summary.total} caption="rows in file" />
        <Stat value={summary.create} caption={`new ${noun}`} />
        {report.kind === "clients" ? (
          <Stat value={summary.link} caption="matched to existing" />
        ) : null}
        <Stat value={summary.unchanged} caption="already imported" />
        <Stat value={summary.errors} caption="rows with a problem" />
      </dl>

      {summary.errors > 0 ? (
        <Alert
          tone="warning"
          title={`${summary.errors} row${summary.errors === 1 ? "" : "s"} will be left out`}
        >
          Fix the file or the settings above and check again, or carry on without them. Left-out
          rows are listed below with the reason.
        </Alert>
      ) : null}

      {issues.length > 0 ? (
        <Table caption="Problems found in the file">
          <THead>
            <TR>
              <TH>Row</TH>
              <TH>Problem</TH>
            </TR>
          </THead>
          <TBody>
            {issues.map((issue, i) => (
              <TR key={`${issue.row}-${i}`}>
                <TD className="w-24 whitespace-nowrap tabular-nums">
                  {issue.row}{" "}
                  <Badge tone={issue.level === "error" ? "danger" : "warning"}>{issue.level}</Badge>
                </TD>
                <TD>{issue.message}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}
      {issueCount > issues.length ? (
        <p className="text-sm text-ink-subtle">
          Showing the first {issues.length} of {issueCount} problems.
        </p>
      ) : null}

      {preview.length > 0 ? (
        <details className="rounded-card border border-line bg-surface p-4">
          <summary className="cursor-pointer font-semibold">
            First rows as read from your file
          </summary>
          <div className="mt-3">
            <Table caption="First rows of the file">
              <THead>
                <TR>
                  {headers.map((h) => (
                    <TH key={h}>{h}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {preview.map((row, i) => (
                  <TR key={i}>
                    {headers.map((h) => (
                      <TD key={h}>{row[h]}</TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
