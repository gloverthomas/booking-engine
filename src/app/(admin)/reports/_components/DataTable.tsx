import { formatAud, type CsvColumnType, type ReportTable } from "@/server/reports";
import { Card, LinkButton, Table } from "../ui-shim";

const NUMERIC: ReadonlySet<CsvColumnType> = new Set(["int", "money", "percent", "decimal"]);

function display(value: unknown, type: CsvColumnType): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "text") return String(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (type === "money") return formatAud(value);
  if (type === "percent") return `${value.toFixed(1)}%`;
  if (type === "decimal") return value.toFixed(2);
  return Math.trunc(value).toLocaleString("en-AU");
}

interface DataTableProps {
  table: ReportTable;
  /** Query string (without "?") for the CSV link, so the export matches what is on screen. */
  exportQuery?: string;
  emptyMessage?: string;
  /** One-line explanation shown under the title. */
  note?: string;
}

/** Any report table, plus its CSV export. Doubles as the accessible table view for the charts above it. */
export function DataTable({
  table,
  exportQuery,
  emptyMessage = "Nothing to show for this range.",
  note,
}: DataTableProps) {
  return (
    <Card aria-labelledby={`t-${table.id}`}>
      <div className="rpt-card-head">
        <div>
          <h2 id={`t-${table.id}`}>{table.title}</h2>
          {note ? <p className="rpt-sub">{note}</p> : null}
        </div>
        <LinkButton
          variant="ghost"
          download=""
          href={`/reports/export/${table.id}${exportQuery ? `?${exportQuery}` : ""}`}
          aria-label={`Download ${table.title} as CSV`}
        >
          Export CSV
        </LinkButton>
      </div>
      {table.rows.length === 0 ? (
        <p className="rpt-empty">{emptyMessage}</p>
      ) : (
        <Table aria-label={table.title}>
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={NUMERIC.has(c.type ?? "text") ? "num" : undefined}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {table.columns.map((c) => {
                  const value = (row as Record<string, unknown>)[c.key];
                  const type = c.type ?? "text";
                  return (
                    <td
                      key={c.key}
                      className={NUMERIC.has(type) ? "num" : undefined}
                      data-negative={
                        type === "money" && typeof value === "number" && value < 0
                          ? "true"
                          : undefined
                      }
                    >
                      {display(value, type)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
