export interface BarRow {
  label: string;
  value: number;
  /** Text printed at the tip of the bar. */
  text: string;
}

/**
 * Horizontal bars in one hue with the value at the tip: for comparing a handful of named things (locations,
 * weekdays, start times). Plain HTML, so it scales with text size and reads as a list to screen readers.
 */
export function BarList({ rows, max, label }: { rows: BarRow[]; max?: number; label: string }) {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="rpt-empty">Nothing to show for this range.</p>;
  return (
    <ul className="rpt-bars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.label} className="rpt-bar-row">
          <span className="rpt-bar-label">{row.label}</span>
          <span className="rpt-bar-track">
            <span
              className="rpt-bar"
              style={{ width: top > 0 ? `calc(${(row.value / top) * 100}% * 0.82)` : "2px" }}
              aria-hidden="true"
            />
            <span className="rpt-bar-value">{row.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
