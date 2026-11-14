import type { ComponentProps } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "peach";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-ink-muted",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  info: "bg-info-tint text-info",
  peach: "bg-peach text-ink",
};

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: BadgeTone;
}

/** A compact status label. Colour never carries meaning alone: always include the text. */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.06em]",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}
