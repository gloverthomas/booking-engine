"use client";

/**
 * TEMPORARY UI kit shim for workstream E.
 *
 * Workstream D owns the real kit in `@/components/ui`. Everything UI-ish in the calendar, bookings,
 * clients and checkout screens is imported from this one file, so the integrator can replace it with a
 * single edit: re-export D's Button, Input, Textarea, Select, Field, Badge, Card, Sheet, Dialog, Chips,
 * Switch, Skeleton and ToastProvider/useToast under the same names (props documented below).
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
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import clsx from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: Array<string | false | null | undefined>): string {
  return twMerge(clsx(inputs));
}

/* Button ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-stone-900 text-white hover:bg-stone-700 active:bg-stone-800 disabled:bg-stone-300",
  secondary:
    "border border-stone-300 bg-white text-stone-900 hover:bg-stone-100 active:bg-stone-200 disabled:text-stone-400",
  danger: "bg-red-700 text-white hover:bg-red-600 active:bg-red-800 disabled:bg-red-300",
  ghost: "text-stone-700 hover:bg-stone-200/70 active:bg-stone-200 disabled:text-stone-400",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden
        />
      ) : null}
      {children}
    </button>
  );
}

/* Form fields ------------------------------------------------------------- */

const FIELD_BASE =
  "min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-base text-stone-900 placeholder:text-stone-400 focus-visible:border-stone-900 focus-visible:outline-2 focus-visible:outline-stone-900 disabled:bg-stone-100";

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
      <label htmlFor={id} className="text-sm font-medium text-stone-700">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-stone-500">{hint}</p> : null}
    </div>
  );
}

/** Labelled on/off control. */
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
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-1">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-stone-900">{label}</span>
        {description ? <span className="text-xs text-stone-500">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-6 shrink-0 accent-stone-900"
      />
    </label>
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
              "min-h-11 min-w-11 flex-1 whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900",
              selected
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100",
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

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-stone-200 text-stone-800",
  good: "bg-emerald-100 text-emerald-900",
  warn: "bg-amber-100 text-amber-900",
  bad: "bg-red-100 text-red-900",
  info: "bg-sky-100 text-sky-900",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-stone-200 bg-white p-4", className)}>
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-stone-200", className)} aria-hidden />;
}

/* Sheet and Dialog (native <dialog>: focus trap, Escape, inert background) -- */

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const handleClose = useCallback(() => {
    if (open) onClose();
  }, [open, onClose]);
  const handleBackdrop = useCallback(
    (event: { target: EventTarget | null }) => {
      if (event.target === ref.current) onClose();
    },
    [onClose],
  );
  return { ref, handleClose, handleBackdrop };
}

function OverlayHeader({
  title,
  titleId,
  onClose,
}: {
  title: string;
  titleId: string;
  onClose: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-stone-200 px-4 py-2">
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="inline-flex size-11 items-center justify-center rounded-lg text-2xl leading-none text-stone-600 hover:bg-stone-100"
      >
        <span aria-hidden>&times;</span>
      </button>
    </header>
  );
}

/** Bottom sheet on phones, right-hand drawer from md up. Children mount only while open. */
export function Sheet({ open, onClose, title, children }: OverlayProps) {
  const titleId = useId();
  const { ref, handleClose, handleBackdrop } = useDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={handleClose}
      onClick={handleBackdrop}
      className="mx-0 mb-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl bg-white p-0 text-stone-900 backdrop:bg-black/40 open:flex open:flex-col md:my-0 md:ml-auto md:h-dvh md:max-h-none md:w-[30rem] md:rounded-none"
    >
      {open ? (
        <>
          <OverlayHeader title={title} titleId={titleId} onClose={onClose} />
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
            {children}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/** Centred modal for short confirmations. */
export function Dialog({ open, onClose, title, children }: OverlayProps) {
  const titleId = useId();
  const { ref, handleClose, handleBackdrop } = useDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={handleClose}
      onClick={handleBackdrop}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-0 text-stone-900 backdrop:bg-black/40"
    >
      {open ? (
        <>
          <OverlayHeader title={title} titleId={titleId} onClose={onClose} />
          <div className="flex flex-col gap-4 p-4">{children}</div>
        </>
      ) : null}
    </dialog>
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const regionRef = useRef<HTMLDivElement>(null);

  // Native <dialog>s sit in the top layer and would hide a normal fixed toast. A manual popover joins the
  // top layer too, and re-showing it puts it above any dialog that opened earlier.
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
              "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg",
              item.tone === "error" && "bg-red-800 text-white",
              item.tone === "success" && "bg-emerald-800 text-white",
              item.tone === "info" && "bg-stone-900 text-white",
            )}
          >
            <div className="flex-1">
              <p className="font-medium">{item.title}</p>
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
