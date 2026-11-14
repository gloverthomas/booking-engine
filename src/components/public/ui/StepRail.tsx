import type { StepId } from "../flow/state";

export const STEP_LABELS: Record<StepId, string> = {
  location: "Location",
  services: "Services",
  time: "Time",
  details: "Details",
  pay: "Deposit",
};

interface StepRailProps {
  steps: readonly StepId[];
  current: StepId;
  canVisit: (step: StepId) => boolean;
  onVisit: (step: StepId) => void;
}

/** Numbered progress rail. Completed steps are buttons so the client can step back. */
export function StepRail({ steps, current, canVisit, onVisit }: StepRailProps) {
  const currentIndex = steps.indexOf(current);
  return (
    <nav aria-label="Booking progress">
      <ol className="rk-rail">
        {steps.map((step, index) => {
          const state =
            index < currentIndex ? "is-done" : index === currentIndex ? "is-current" : "";
          const reachable = index < currentIndex && canVisit(step);
          return (
            <li key={step} className={`rk-rail__item ${state}`}>
              <button
                type="button"
                className="rk-rail__btn"
                disabled={!reachable}
                aria-current={index === currentIndex ? "step" : undefined}
                onClick={() => onVisit(step)}
              >
                <span className="rk-rail__num">{String(index + 1).padStart(2, "0")}</span>
                <span className="rk-rail__label">{STEP_LABELS[step]}</span>
                <span className="rk-sr-only">
                  {index < currentIndex
                    ? " (completed)"
                    : index === currentIndex
                      ? " (current step)"
                      : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
