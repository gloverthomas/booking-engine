import { useId, type ComponentProps, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "./cn";

interface ToggleBaseProps extends Omit<ComponentProps<"input">, "type" | "size"> {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  wrapperClassName?: string;
}

export type CheckboxProps = ToggleBaseProps;
export type SwitchProps = ToggleBaseProps;

function Messages({ id, hint, error }: { id: string; hint?: ReactNode; error?: string | null }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

function describedByIds(id: string, hint?: ReactNode, error?: string | null) {
  const parts = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** A labelled checkbox. The whole row is the 44px target. */
export function Checkbox({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={cn("flex flex-col gap-1", wrapperClassName)}>
      <label
        htmlFor={inputId}
        className="flex min-h-11 cursor-pointer items-center gap-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
      >
        <span className="relative inline-flex size-5 shrink-0">
          <input
            id={inputId}
            type="checkbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedByIds(inputId, hint, error)}
            className={cn(
              "peer size-5 cursor-[inherit] appearance-none rounded-[4px] border border-line-strong bg-surface",
              "checked:border-primary checked:bg-primary hover:border-ink",
              className,
            )}
            {...rest}
          />
          <Check
            aria-hidden
            strokeWidth={3}
            className="pointer-events-none absolute inset-0.5 size-4 text-on-primary opacity-0 peer-checked:opacity-100"
          />
        </span>
        <span className="text-[0.9375rem] text-ink">{label}</span>
      </label>
      <Messages id={inputId} hint={hint} error={error} />
    </div>
  );
}

/** An on/off setting that applies immediately in meaning (role="switch"). */
export function Switch({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  id,
  ...rest
}: SwitchProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={cn("flex flex-col gap-1", wrapperClassName)}>
      <label
        htmlFor={inputId}
        className="flex min-h-11 cursor-pointer items-center justify-between gap-4 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
      >
        <span className="text-[0.9375rem] text-ink">{label}</span>
        <span className="relative inline-flex h-7 w-12 shrink-0">
          <input
            id={inputId}
            type="checkbox"
            role="switch"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedByIds(inputId, hint, error)}
            className={cn(
              "peer h-7 w-12 cursor-[inherit] appearance-none rounded-full border border-line-strong bg-sunken",
              "checked:border-primary checked:bg-primary",
              className,
            )}
            {...rest}
          />
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-ink-muted",
              "transition-transform duration-[var(--duration-fast)]",
              "peer-checked:translate-x-5 peer-checked:bg-on-primary",
            )}
          />
        </span>
      </label>
      <Messages id={inputId} hint={hint} error={error} />
    </div>
  );
}
