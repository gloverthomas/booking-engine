import { PROGRESS_LABEL, type Progress } from "@/server/targets/progress";

const MARK = { met: "✓", on_pace: "→", behind: "!", missed: "✕", no_data: "?" } as const;

/**
 * Progress towards a target. Never colour alone: the bar length, a tick for how far through the period we
 * are, the percentage in words and a status label with a symbol all say the same thing.
 */
export function ProgressBar({
  progress,
  elapsedPct,
  label,
}: {
  progress: Progress;
  elapsedPct: number;
  label: string;
}) {
  const text = progress.pct === null ? "No data yet" : `${progress.pct}% of target`;
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.barPct}
        aria-valuetext={`${text}, ${PROGRESS_LABEL[progress.status]}`}
        className="relative h-3 w-full overflow-hidden rounded-pill border border-line-strong bg-sunken"
      >
        <div className="h-full bg-ink" style={{ width: `${progress.barPct}%` }} />
        {elapsedPct > 0 && elapsedPct < 100 ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-peach mix-blend-difference"
            style={{ left: `${elapsedPct}%` }}
          />
        ) : null}
      </div>
      <p className="flex flex-wrap justify-between gap-x-3 text-sm">
        <span className="tabular-nums">{text}</span>
        <span className="font-semibold">
          <span aria-hidden="true">{MARK[progress.status]} </span>
          {PROGRESS_LABEL[progress.status]}
        </span>
      </p>
    </div>
  );
}
