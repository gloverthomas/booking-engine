import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface TableProps extends ComponentProps<"table"> {
  /** Accessible name for the table. Rendered as a visually hidden caption. */
  caption?: string;
}

/** Scrolls horizontally inside its container on narrow screens instead of breaking the page. */
export function Table({ caption, className, children, ...rest }: TableProps) {
  return (
    <div className="w-full overflow-x-auto rounded-card border border-line bg-surface">
      <table
        className={cn("w-full border-collapse text-left text-[0.9375rem]", className)}
        {...rest}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...rest }: ComponentProps<"thead">) {
  return <thead className={cn("bg-sunken", className)} {...rest} />;
}

export function TBody({ className, ...rest }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-line", className)} {...rest} />;
}

export function TR({ className, ...rest }: ComponentProps<"tr">) {
  return <tr className={cn("hover:bg-paper", className)} {...rest} />;
}

export function TH({ className, scope = "col", ...rest }: ComponentProps<"th">) {
  return (
    <th
      scope={scope}
      className={cn(
        "whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-[0.09em] text-ink-subtle",
        className,
      )}
      {...rest}
    />
  );
}

export function TD({ className, ...rest }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...rest} />;
}
