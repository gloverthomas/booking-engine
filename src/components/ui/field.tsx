import type { ReactNode } from "react";
import { cn } from "./cn";

/** Props shared by Input, Textarea, Select, Checkbox and Switch for labelling and validation. */
export interface FieldMessageProps {
  /** Visible label. Always provide one; it is the control's accessible name. */
  label: ReactNode;
  /** Helper text under the control. */
  hint?: ReactNode;
  /** Validation message. Sets aria-invalid and is announced with the control. */
  error?: string | null;
}

export interface FieldIds {
  id: string;
  hintId: string;
  errorId: string;
}

export function fieldIds(id: string): FieldIds {
  return { id, hintId: `${id}-hint`, errorId: `${id}-error` };
}

/** aria-describedby value for a control with optional hint/error. */
export function describedBy(ids: FieldIds, props: Pick<FieldMessageProps, "hint" | "error">) {
  const parts = [props.hint ? ids.hintId : null, props.error ? ids.errorId : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

interface FieldShellProps extends FieldMessageProps {
  ids: FieldIds;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint + error. Used by the form controls in this folder. */
export function FieldShell({
  ids,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={ids.id} className="text-sm font-semibold text-ink">
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-ink-subtle">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p id={ids.hintId} className="text-sm text-ink-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Shared visual treatment for text-like controls. */
export const controlClasses =
  "w-full min-h-11 rounded-control border bg-surface px-3 text-base text-ink " +
  "placeholder:text-ink-subtle transition-colors duration-[var(--duration-fast)] " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-subtle";

export function controlBorder(error: string | null | undefined): string {
  return error ? "border-danger" : "border-line-strong hover:border-ink";
}
