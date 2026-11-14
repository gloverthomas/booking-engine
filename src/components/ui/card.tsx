import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export interface CardProps extends ComponentProps<"section"> {
  /** "peach" is the brand emphasis surface. */
  tone?: "default" | "peach";
}

/** A flat bordered surface. Use <section> semantics; give it a heading (CardTitle) so it is labelled. */
export function Card({ tone = "default", className, ...rest }: CardProps) {
  return (
    <section
      className={cn(
        "rounded-card border border-line",
        tone === "peach" ? "bg-peach" : "bg-surface",
        className,
      )}
      {...rest}
    />
  );
}

export interface CardHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  title?: ReactNode;
  /** Small label above the title. */
  eyebrow?: ReactNode;
  /** Right-aligned actions (buttons, badges). */
  actions?: ReactNode;
}

export function CardHeader({
  title,
  eyebrow,
  actions,
  className,
  children,
  ...rest
}: CardHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line px-5 py-4",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
        {title ? <CardTitle>{title}</CardTitle> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardTitle({ className, ...rest }: ComponentProps<"h2">) {
  return <h2 className={cn("display text-xl", className)} {...rest} />;
}

export function CardBody({ className, ...rest }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3",
        "rounded-b-card",
        className,
      )}
      {...rest}
    />
  );
}
