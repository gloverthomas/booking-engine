"use client";

/**
 * Adapter between the calendar, bookings, clients and checkout screens and the shared UI kit in
 * `@/components/ui`. The screens keep the small prop surface they were built against; this file maps it
 * onto the kit (Button, Badge, Dialog, Sheet, Switch) and styles the few bare controls with the same
 * design tokens (see src/components/ui/README.md).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import {
  Badge as KitBadge,
  Dialog as KitDialog,
  Sheet as KitSheet,
  Switch as KitSwitch,
  cn,
  type BadgeTone as KitBadgeTone,
} from "@/components/ui";

export { cn };
export { Button, type ButtonProps } from "@/components/ui";

/* Form fields ------------------------------------------------------------- */

const FIELD_BASE =
  "min-h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-base text-ink " +
  "placeholder:text-ink-subtle disabled:bg-sunken disabled:opacity-70";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD_BASE, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD_BASE, "min-h-24 py-2", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(FIELD_BASE, "pr-8", className)} {...rest} />;
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-sm text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

/** Labelled on/off control (the kit's Switch with a boolean `onChange`). */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <KitSwitch
      label={label}
      hint={description}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/* Chips (single choice) --------------------------------------------------- */

export function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  /** Null means nothing is chosen yet. */
  value: T | null;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-11 min-w-11 flex-1 whitespace-nowrap rounded-pill border px-3 text-sm font-semibold transition-colors",
              selected
                ? "border-primary bg-primary text-on-primary"
                : "border-line-strong bg-surface text-ink hover:bg-peach",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* Badge / Card / Skeleton ------------------------------------------------- */

type BadgeTone = "neutral" | "good" | "warn" | "bad" | "info";

const BADGE_TONES: Record<BadgeTone, KitBadgeTone> = {
  neutral: "neutral",
  good: "success",
  warn: "warning",
  bad: "danger",
  info: "info",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <KitBadge tone={BADGE_TONES[tone]}>{children}</KitBadge>;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-card border border-line bg-surface p-4", className)}>
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-control bg-sunken", className)} aria-hidden />;
}

/* Sheet and Dialog (the kit's native <dialog>s) ------------------------------ */

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** Bottom sheet on phones, right-hand drawer from md up. Children mount only while open. */
export function Sheet({ open, onClose, title, children }: OverlayProps) {
  return (
    <KitSheet open={open} onClose={onClose} title={title}>
      {open ? children : null}
    </KitSheet>
  );
}

/** Centred modal for short confirmations. Children mount only while open. */
export function Dialog({ open, onClose, title, children }: OverlayProps) {
  return (
    <KitDialog open={open} onClose={onClose} title={title}>
      {open ? <div className="flex flex-col gap-4">{children}</div> : null}
    </KitDialog>
  );
}

/* Toasts ------------------------------------------------------------------ */

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

type ToastFn = (toast: { tone?: ToastTone; title: string; description?: string }) => void;

const ToastContext = createContext<ToastFn | null>(null);

/**
 * Kept local (rather than the shell's provider) because native <dialog>s sit in the top layer and would
 * hide a normal fixed toast. A manual popover joins the top layer too, and re-showing it puts it above
 * any dialog that opened earlier.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const regionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof region.showPopover !== "function") return;
    if (region.matches(":popover-open")) region.hidePopover();
    if (items.length > 0) region.showPopover();
  }, [items]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    ({ tone = "info", title, description }) => {
      const id = nextId.current++;
      setItems((current) => [...current, { id, tone, title, description }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 9000 : 4500);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        ref={regionRef}
        popover="manual"
        className="pointer-events-none fixed inset-x-0 bottom-0 top-auto z-[100] m-0 flex h-auto w-full flex-col items-center gap-2 overflow-visible border-0 bg-transparent p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-card px-4 py-3 text-sm shadow-overlay",
              item.tone === "error" && "bg-danger text-on-danger",
              item.tone === "success" && "bg-success text-white",
              item.tone === "info" && "bg-primary text-on-primary",
            )}
          >
            <div className="flex-1">
              <p className="font-semibold">{item.title}</p>
              {item.description ? <p className="mt-0.5 opacity-90">{item.description}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss"
              className="-m-2 inline-flex size-11 items-center justify-center text-xl leading-none opacity-80 hover:opacity-100"
            >
              <span aria-hidden>&times;</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  return useMemo(() => toast ?? (() => undefined), [toast]);
}
