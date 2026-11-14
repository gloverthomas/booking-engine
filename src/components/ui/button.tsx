import Link from "next/link";
import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex select-none items-center justify-center gap-2 rounded-control border font-semibold " +
  "transition-[background-color,color,border-color,opacity] duration-[var(--duration-fast)] " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "border-primary bg-primary text-on-primary hover:opacity-90 active:opacity-80",
  secondary:
    "border-line-strong bg-surface text-ink hover:bg-peach active:bg-peach active:border-ink",
  ghost: "border-transparent bg-transparent text-ink hover:bg-peach active:bg-peach",
  danger: "border-danger bg-danger text-on-danger hover:opacity-90 active:opacity-80",
};

// sm is compact for mouse use but still 44px on touch devices.
const sizes: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-sm pointer-coarse:min-h-11",
  md: "min-h-11 px-4 text-[0.9375rem]",
  lg: "min-h-13 px-6 text-base",
};

export interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/** Class names for anything that should look like a button (links, summary elements). */
export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
}: ButtonStyleProps = {}): string {
  return cn(base, variants[variant], sizes[size], fullWidth && "w-full");
}

export interface ButtonProps extends ComponentProps<"button">, ButtonStyleProps {
  /** Shows a spinner and disables the button while an action runs. */
  loading?: boolean;
}

export function Button({
  variant,
  size,
  fullWidth,
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
      className={cn(buttonClasses({ variant, size, fullWidth }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      ) : null}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends ComponentProps<typeof Link>, ButtonStyleProps {}

/** A Next.js Link styled as a button. */
export function ButtonLink({ variant, size, fullWidth, className, ...rest }: ButtonLinkProps) {
  return <Link className={cn(buttonClasses({ variant, size, fullWidth }), className)} {...rest} />;
}
