import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Usually a primary Button or ButtonLink. */
  action?: ReactNode;
  icon?: ReactNode;
}

/** For lists and screens with nothing in them yet. Say what is missing and offer the next step. */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface px-6 py-10 text-center",
        className,
      )}
      {...rest}
    >
      {icon ? (
        <div aria-hidden className="text-ink-subtle">
          {icon}
        </div>
      ) : null}
      <p className="display text-xl">{title}</p>
      {description ? <p className="max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
