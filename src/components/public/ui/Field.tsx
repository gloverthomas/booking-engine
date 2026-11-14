import type { ReactNode } from "react";
import { Check } from "./icons";

interface BaseFieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  optional?: boolean;
  wide?: boolean;
}

interface TextFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel";
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel";
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
}

/** Label, control, hint and error, wired together with aria-describedby / aria-invalid. */
export function TextField({
  id,
  label,
  error,
  hint,
  optional,
  wide,
  value,
  onChange,
  type = "text",
  autoComplete,
  inputMode,
  placeholder,
  required,
  multiline,
  maxLength,
}: TextFieldProps) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  const common = {
    id,
    name: id,
    className: "rk-input",
    value,
    placeholder,
    required,
    maxLength,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  } as const;

  return (
    <div className={`rk-field${wide ? " rk-field--wide" : ""}`}>
      <label className="rk-field__label" htmlFor={id}>
        <span>{label}</span>
        {optional ? <span className="rk-field__opt">optional</span> : null}
      </label>
      {hint ? (
        <p className="rk-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {multiline ? (
        <textarea {...common} rows={3} />
      ) : (
        <input {...common} type={type} autoComplete={autoComplete} inputMode={inputMode} />
      )}
      {error ? (
        <p className="rk-field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface CheckFieldProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

export function CheckField({ id, checked, onChange, error, required, children }: CheckFieldProps) {
  return (
    <div>
      <label className="rk-check" htmlFor={id}>
        <input
          id={id}
          name={id}
          className="rk-check__input"
          type="checkbox"
          checked={checked}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="rk-check__box">
          <Check size={16} />
        </span>
        <span className="rk-check__text">{children}</span>
      </label>
      {error ? (
        <p className="rk-field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
