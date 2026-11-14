import { useId, type ComponentProps } from "react";
import { cn } from "./cn";
import {
  controlBorder,
  controlClasses,
  describedBy,
  FieldShell,
  fieldIds,
  type FieldMessageProps,
} from "./field";

export interface TextareaProps extends ComponentProps<"textarea">, FieldMessageProps {
  wrapperClassName?: string;
}

export function Textarea({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  id,
  required,
  rows = 4,
  ...rest
}: TextareaProps) {
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
      <textarea
        id={ids.id}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, { hint, error })}
        className={cn(controlClasses, "py-2.5 leading-6", controlBorder(error), className)}
        {...rest}
      />
    </FieldShell>
  );
}
