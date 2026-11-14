import Link from "next/link";
import { cn } from "@/components/ui/cn";

const LINKS = [
  { key: "services", href: "/catalog", label: "Services" },
  { key: "locations", href: "/catalog/locations", label: "Locations" },
] as const;

/** Section switcher between the two catalog lists (plain links so it works without JavaScript). */
export function CatalogNav({ active }: { active: "services" | "locations" }) {
  return (
    <nav aria-label="Catalog sections" className="flex gap-1 border-b border-line">
      {LINKS.map((link) => (
        <Link
          key={link.key}
          href={link.href}
          aria-current={link.key === active ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex min-h-11 items-center border-b-2 px-4 text-[0.9375rem] font-semibold",
            link.key === active
              ? "border-ink text-ink"
              : "border-transparent text-ink-muted hover:text-ink",
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
