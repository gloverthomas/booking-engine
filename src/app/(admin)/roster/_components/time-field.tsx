"use client";

import { hhmmToMinutes, minutesToHhmm } from "@/server/admin-foundation/week";

/** A native time input working in local minutes since midnight. */
export function TimeField({
  label,
  minutes,
  onChange,
}: {
  label: string;
  minutes: number;
  onChange: (minutes: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="sr-only">{label}</span>
      <input
        type="time"
        step={300}
        aria-label={label}
        value={minutesToHhmm(Math.min(minutes, 1439))}
        onChange={(e) => {
          const parsed = hhmmToMinutes(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
        className="min-h-11 w-full min-w-[7.5rem] rounded-control border border-line-strong bg-surface px-3 text-base text-ink hover:border-ink"
      />
    </label>
  );
}
