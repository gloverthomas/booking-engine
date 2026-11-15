"use client";

import { cn } from "./ui-shim";

export interface StaffChipOption {
  id: string;
  name: string;
  colour: string;
}

/**
 * Stylist filter. A scrollable row of toggle chips, each with its calendar colour, so it stays one line
 * tall on a phone however many people are on the team. Empty `selected` means everyone.
 */
export function StaffChips({
  staff,
  selected,
  onSelect,
  onSelectAll,
}: {
  staff: readonly StaffChipOption[];
  selected: readonly string[];
  onSelect: (id: string) => void;
  onSelectAll: () => void;
}) {
  const all = selected.length === 0;
  return (
    <div
      role="group"
      aria-label="Stylists"
      className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 md:mx-0 md:flex-wrap md:px-0"
    >
      <Chip pressed={all} onClick={onSelectAll}>
        All stylists
      </Chip>
      {staff.map((s) => (
        <Chip
          key={s.id}
          pressed={selected.includes(s.id)}
          onClick={() => onSelect(s.id)}
          colour={s.colour}
        >
          {s.name}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  colour,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  colour?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill border px-3 text-sm font-semibold transition-colors",
        pressed
          ? "border-primary bg-primary text-on-primary"
          : "border-line-strong bg-surface text-ink hover:bg-peach",
      )}
    >
      {colour ? (
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-full border border-white/70"
          style={{ backgroundColor: colour }}
        />
      ) : null}
      {children}
    </button>
  );
}
