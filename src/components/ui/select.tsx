import { useId, type ComponentProps } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";
import {
  controlBorder,
  controlClasses,
  describedBy,
  FieldShell,
  fieldIds,
  type FieldMessageProps,
} from "./field";

export interface SelectProps extends Omit<ComponentProps<"select">, "size">, FieldMessageProps {
  wrapperClassName?: string;
}

/** Native <select> (best keyboard and mobile behaviour) with the house styling. Pass <option>s as children. */
export function Select({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  children,
  id,
  required,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const ids = fieldIds(id ?? autoId);
  return (
    <FieldShell
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={wrapperClassName}
    >
      <div className="relative">
        <select
          id={ids.id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, { hint, error })}
          className={cn(
            controlClasses,
            "cursor-pointer appearance-none pr-10",
            controlBorder(error),
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        />
      </div>
    </FieldShell>
  );
}
