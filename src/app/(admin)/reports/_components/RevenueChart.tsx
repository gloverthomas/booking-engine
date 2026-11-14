import { bucketLabel, formatAud, type Granularity, type RevenueReport } from "@/server/reports";

type Point = RevenueReport["series"][number];

const W = 760;
const H = 300;
const M = { left: 56, right: 8, top: 12, bottom: 34 };
const GAP = 2; // surface gap between stacked segments
const MAX_BAR = 24;
const RADIUS = 4;

const SEGMENTS = [
  { key: "depositsCents", label: "Deposits", cls: "seg-1" },
  { key: "balancesCents", label: "Balances", cls: "seg-2" },
  { key: "feeChargesCents", label: "Fees charged", cls: "seg-3" },
] as const;

/** A "nice" axis maximum and tick step, in dollars, for a maximum given in cents. */
export function niceScale(maxCents: number): { max: number; step: number } {
  const dollars = Math.max(maxCents / 100, 1);
  const rough = dollars / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  return { max: Math.ceil(dollars / step) * step, step };
}

/** Rounded top corners only, square at the baseline. */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const dollarsLabel = (d: number): string => `$${d.toLocaleString("en-AU")}`;

interface RevenueChartProps {
  series: Point[];
  granularity: Granularity;
}

/**
 * Money received per period as stacked columns: deposits, balances, fees charged. Refunds are not drawn (they
 * would hide under the baseline); they are in the table and the tiles. Inline SVG, no dependency: the data is
 * a handful of rectangles, so a charting library would only add weight. Hover shows the exact figures (native
 * tooltips), the legend names every series, and the table below the chart is the accessible view of the same data.
 */
export function RevenueChart({ series, granularity }: RevenueChartProps) {
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const totals = series.map((p) => p.depositsCents + p.balancesCents + p.feeChargesCents);
  const { max, step } = niceScale(Math.max(0, ...totals));
  const maxCents = max * 100;
  const yOf = (cents: number) => M.top + innerH - (cents / maxCents) * innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const slot = innerW / Math.max(series.length, 1);
  const barW = Math.max(2, Math.min(MAX_BAR, slot * 0.7));
  const labelEvery = Math.ceil(series.length / 8);
  const grandTotal = totals.reduce((a, b) => a + b, 0);

  return (
    <figure style={{ margin: 0 }}>
      <ul className="rpt-legend" aria-label="Legend">
        {SEGMENTS.map((s) => (
          <li key={s.key}>
            <span
              className="rpt-swatch"
              style={{ background: `var(--rpt-series-${SEGMENTS.indexOf(s) + 1})` }}
              aria-hidden="true"
            />
            {s.label}
          </li>
        ))}
      </ul>
      <svg
        className="rpt-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Money received per ${granularity}, ${formatAud(grandTotal)} in total. The table below has every figure.`}
      >
        <defs>
          <pattern
            id="rpt-hatch-45"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="Canvas" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="CanvasText" strokeWidth="2" />
          </pattern>
          <pattern
            id="rpt-hatch-135"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(135)"
          >
            <rect width="6" height="6" fill="Canvas" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="CanvasText" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={t === 0 ? "axis" : "grid"}
              x1={M.left}
              x2={W - M.right}
              y1={yOf(t * 100)}
              y2={yOf(t * 100)}
            />
            <text x={M.left - 8} y={yOf(t * 100) + 4} textAnchor="end">
              {dollarsLabel(t)}
            </text>
          </g>
        ))}
        {series.map((p, i) => {
          const cx = M.left + slot * i + slot / 2;
          const x = cx - barW / 2;
          const values = SEGMENTS.map((s) => p[s.key]);
          const topIndex = values.reduce((last, v, idx) => (v > 0 ? idx : last), -1);
          let stacked = 0;
          const title = `${bucketLabel(p.period, granularity)}: deposits ${formatAud(p.depositsCents)}, balances ${formatAud(p.balancesCents)}, fees charged ${formatAud(p.feeChargesCents)}, refunds ${formatAud(p.refundsCents)}, net ${formatAud(p.netCents)}`;
          return (
            <g key={p.period} className="col">
              <title>{title}</title>
              {/* A wider invisible target so thin bars are easy to hover. */}
              <rect x={cx - slot / 2} y={M.top} width={slot} height={innerH} fill="transparent" />
              {SEGMENTS.map((s, idx) => {
                const v = values[idx];
                if (v <= 0) return null;
                const yTop = yOf(stacked + v);
                const yBottom = yOf(stacked);
                stacked += v;
                const gap = idx === 0 || stacked === v ? 0 : GAP;
                const h = Math.max(1, yBottom - yTop - gap);
                const y = yTop;
                return idx === topIndex ? (
                  <path key={s.key} className={s.cls} d={topRounded(x, y, barW, h)} />
                ) : (
                  <rect key={s.key} className={s.cls} x={x} y={y} width={barW} height={h} />
                );
              })}
              {i % labelEvery === 0 ? (
                <text x={cx} y={H - 12} textAnchor="middle">
                  {shortLabel(p.period, granularity)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function shortLabel(period: string, granularity: Granularity): string {
  const label = bucketLabel(period, granularity);
  return granularity === "day" ? label.replace(/^\w+ /, "") : label.replace(/^Wk of /, "");
}
