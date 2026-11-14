import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export interface PageHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  title: ReactNode;
  /** Small label above the title (section name, date, count). */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Primary actions, right-aligned on wide screens and stacked below on phones. */
  actions?: ReactNode;
}

/** The top of every admin page: heavy uppercase display title, quiet description, actions. */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
  ...rest
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 border-b border-ink pb-5 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
        <h1 className="display text-[clamp(2rem,1.4rem+2.6vw,3.25rem)]">{title}</h1>
        {description ? <p className="mt-3 max-w-prose text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
