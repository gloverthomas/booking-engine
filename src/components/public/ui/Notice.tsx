import type { ReactNode } from "react";
import { Alert } from "./icons";

interface NoticeProps {
  tone?: "info" | "error";
  children: ReactNode;
}

/** Announced to assistive tech when it appears. Errors interrupt (alert); info is polite (status). */
export function Notice({ tone = "info", children }: NoticeProps) {
  return (
    <div
      className={`rk-notice${tone === "error" ? " rk-notice--error" : ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Alert className="rk-notice__icon" size={22} />
      <div>{children}</div>
    </div>
  );
}

interface ErrorPanelProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorPanel({ message, onRetry }: ErrorPanelProps) {
  return (
    <div className="rk-error-panel" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="rk-btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rk-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} style={{ "--i": i } as React.CSSProperties} />
      ))}
    </div>
  );
}
