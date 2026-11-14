"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

export type OverlayPlacement = "center" | "bottom" | "right";

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row pinned to the bottom (buttons). */
  footer?: ReactNode;
  className?: string;
  placement: OverlayPlacement;
}

const placements: Record<OverlayPlacement, string> = {
  center:
    "m-auto w-[min(32rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-card animate-[ui-fade-in_var(--duration-normal)_var(--ease-out)]",
  // Bottom sheet on phones: full width, anchored to the bottom, safe-area aware.
  bottom:
    "m-0 mt-auto w-full max-w-none max-h-[88dvh] rounded-t-card rounded-b-none pb-[env(safe-area-inset-bottom)] animate-[ui-sheet-up_var(--duration-normal)_var(--ease-out)]",
  right:
    "m-0 ml-auto h-dvh max-h-none w-[min(28rem,100vw)] rounded-none animate-[ui-sheet-in-right_var(--duration-normal)_var(--ease-out)]",
};

/**
 * Built on the native <dialog>: focus is trapped, Escape closes, focus returns to the trigger,
 * and everything behind is inert, with no focus-trap code to maintain.
 */
function Overlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  placement,
}: OverlayProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // `close` fires for Escape and for programmatic close; keep React state in step.
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> element itself.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "flex-col overflow-hidden border border-line bg-surface p-0 text-ink shadow-overlay",
        "backdrop:bg-[var(--scrim)] open:flex",
        placements[placement],
        className,
      )}
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="display text-xl">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1.5 text-sm text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-peach hover:text-ink"
        >
          <X aria-hidden className="size-5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer ? (
        <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-sunken px-5 py-3">
          {footer}
        </footer>
      ) : null}
    </dialog>
  );
}

export type DialogProps = Omit<OverlayProps, "placement">;

/** A centred modal dialog. Controlled: you own `open` and `onClose`. */
export function Dialog(props: DialogProps) {
  return <Overlay {...props} placement="center" />;
}

export interface SheetProps extends Omit<OverlayProps, "placement"> {
  /** "bottom" (default) slides up and suits phones; "right" is a side panel for desktop. */
  side?: "bottom" | "right";
}

/** A sheet anchored to the bottom or right edge. Same behaviour and props as Dialog. */
export function Sheet({ side = "bottom", ...props }: SheetProps) {
  return <Overlay {...props} placement={side} />;
}
