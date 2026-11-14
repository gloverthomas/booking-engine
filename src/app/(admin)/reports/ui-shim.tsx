/**
 * Local stand-ins for the shared UI kit (workstream D owns src/components/ui). Plain elements with obvious
 * names, so the integrator can replace this whole file with one import:
 *
 *   export { Card, Button, LinkButton, Input, Select, Field, Table, Badge } from "@/components/ui";
 *
 * Nothing else under (admin)/reports imports a UI primitive from anywhere but here.
 */
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";

export function Card({ children, ...rest }: ComponentPropsWithoutRef<"section">) {
  return (
    <section className="rpt-card" {...rest}>
      {children}
    </section>
  );
}

export function Button({
  variant = "solid",
  ...rest
}: ComponentPropsWithoutRef<"button"> & { variant?: "solid" | "ghost" }) {
  return <button className="rpt-btn" data-variant={variant} {...rest} />;
}

export function LinkButton({
  variant = "solid",
  href,
  children,
  ...rest
}: Omit<ComponentPropsWithoutRef<"a">, "href"> & { href: string; variant?: "solid" | "ghost" }) {
  const external = rest.download !== undefined;
  const props = { className: "rpt-btn", "data-variant": variant, ...rest };
  // Downloads must be plain anchors (a client-side navigation would try to render the CSV as a page).
  return external ? (
    <a href={href} {...props}>
      {children}
    </a>
  ) : (
    <Link href={href} {...props}>
      {children}
    </Link>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="rpt-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Input(props: ComponentPropsWithoutRef<"input">) {
  return <input className="rpt-input" {...props} />;
}

export function Select(props: ComponentPropsWithoutRef<"select">) {
  return <select className="rpt-select" {...props} />;
}

export function Table({ children, ...rest }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="rpt-table-wrap" tabIndex={0} role="region" aria-label={rest["aria-label"]}>
      <table className="rpt-table" {...rest}>
        {children}
      </table>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "good" | "warn" | "bad"; children: ReactNode }) {
  const icon = tone === "good" ? "✓" : tone === "warn" ? "!" : "✕";
  return (
    <span className="rpt-status" data-tone={tone}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}
