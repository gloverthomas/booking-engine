export type CsvColumnType = "text" | "int" | "money" | "percent" | "decimal";

export interface CsvColumn<Row> {
  key: keyof Row & string;
  header: string;
  type?: CsvColumnType;
}

const FORMULA_TRIGGERS = /^\s*[=+\-@]|^[\t\r]/;

/**
 * Neutralise spreadsheet formula injection: a text cell that Excel/Sheets/Numbers could evaluate
 * (starts with = + - @ tab or CR, ignoring leading spaces) gets a leading apostrophe.
 */
export function guardFormula(text: string): string {
  return FORMULA_TRIGGERS.test(text) ? `'${text}` : text;
}

/** RFC 4180 quoting: wrap in quotes when the cell has a comma, quote or line break; double inner quotes. */
export function escapeCsvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCell(value: unknown, type: CsvColumnType): string {
  if (value === null || value === undefined) return "";
  if (type === "text") return escapeCsvCell(guardFormula(String(value)));
  // Numeric columns are written as real numbers (never guarded, so negatives stay numeric).
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return "";
  if (type === "money") return (n / 100).toFixed(2);
  if (type === "percent") return n.toFixed(1);
  if (type === "decimal") return n.toFixed(2);
  return String(Math.trunc(n));
}

/** CSV with CRLF line ends and a UTF-8 BOM so Excel reads accents correctly. */
export function toCsv<Row extends object>(
  columns: readonly CsvColumn<Row>[],
  rows: readonly Row[],
): string {
  const header = columns.map((c) => escapeCsvCell(guardFormula(c.header))).join(",");
  const lines = rows.map((row) =>
    columns
      .map((c) => formatCell((row as Record<string, unknown>)[c.key], c.type ?? "text"))
      .join(","),
  );
  return `\uFEFF${[header, ...lines].join("\r\n")}\r\n`;
}
