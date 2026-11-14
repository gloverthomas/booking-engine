import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";
import {
  controlBorder,
  controlClasses,
  describedBy,
  FieldShell,
  fieldIds,
  type FieldMessageProps,
} from "./field";

export interface InputProps
  extends Omit<ComponentProps<"input">, "prefix" | "size">, FieldMessageProps {
  /** Short text before the value inside the control, e.g. "$". */
  prefix?: ReactNode;
  /** Short text after the value inside the control, e.g. "min". */
  suffix?: ReactNode;
  wrapperClassName?: string;
}

export function Input({
  label,
  hint,
  error,
  prefix,
  suffix,
  wrapperClassName,
  className,
  id,
  required,
  ...rest
}: InputProps) {
  const autoId = useId();
  const ids = fieldIds(id ?? autoId);
  const hasAdornment = Boolean(prefix || suffix);

  const input = (
    <input
      id={ids.id}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(ids, { hint, error })}
      className={cn(
        hasAdornment ? "min-h-0 flex-1 bg-transparent px-0 py-2 outline-none" : controlClasses,
        !hasAdornment && controlBorder(error),
        className,
      )}
      {...rest}
    />
  );

  return (
    <FieldShell
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={wrapperClassName}
    >
      {hasAdornment ? (
        <div
          className={cn(
            "flex min-h-11 items-center gap-2 rounded-control border bg-surface px-3",
            "focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-focus",
            controlBorder(error),
            rest.disabled && "cursor-not-allowed bg-sunken text-ink-subtle",
          )}
        >
          {prefix ? <span className="text-ink-subtle">{prefix}</span> : null}
          {input}
          {suffix ? <span className="text-ink-subtle">{suffix}</span> : null}
        </div>
      ) : (
        input
      )}
    </FieldShell>
  );
}
