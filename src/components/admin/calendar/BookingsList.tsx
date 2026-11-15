"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { BookingListFilter, BookingListRow } from "@/server/admin/types";
import { BookingSheet } from "./BookingSheet";
import { STATUS_LABEL, STATUS_TONE, formatDay, formatMoney, formatTime } from "./format";
import { Badge, Button, Input, ToastProvider, cn } from "./ui-shim";

const TABS: ReadonlyArray<{ value: BookingListFilter; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "cancelled", label: "Cancelled" },
];

function href(filter: BookingListFilter, q: string): string {
  const params = new URLSearchParams({ view: filter });
  if (q) params.set("q", q);
  return `/bookings?${params.toString()}`;
}

export function BookingsList(props: {
  rows: BookingListRow[];
  filter: BookingListFilter;
  q: string;
  timezone: string;
  limit: number;
  /** Name the stylist on each row (roles that see everyone's bookings). */
  showStylist?: boolean;
}) {
  return (
    <ToastProvider>
      <BookingsScreen {...props} />
    </ToastProvider>
  );
}

function BookingsScreen({
  rows,
  filter,
  q,
  timezone,
  limit,
  showStylist = false,
}: {
  rows: BookingListRow[];
  filter: BookingListFilter;
  q: string;
  timezone: string;
  limit: number;
  showStylist?: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const closeSheet = useCallback(() => setOpenId(null), []);
  const refresh = useCallback(() => router.refresh(), [router]);

  // Group by local day, keeping the order the server gave us.
  const groups: Array<{ day: string; rows: BookingListRow[] }> = [];
  for (const row of rows) {
    const day = formatDay(row.start, timezone);
    const last = groups.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 md:p-6">
      <h1 className="text-2xl font-semibold">{showStylist ? "Bookings" : "My bookings"}</h1>

      <nav aria-label="Booking filter" className="flex gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            href={href(tab.value, q)}
            aria-current={tab.value === filter ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 flex-1 items-center justify-center rounded-full border px-4 text-sm font-medium",
              tab.value === filter
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-stone-800 hover:bg-stone-100",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <form action="/bookings" method="get" role="search" className="flex gap-2">
        <input type="hidden" name="view" value={filter} />
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search client name, phone or email"
          aria-label="Search bookings"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">
          {q ? `No ${filter} bookings match "${q}".` : `No ${filter} bookings.`}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.day} aria-label={group.day} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                {group.day}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(row.id)}
                      className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-left hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-stone-900"
                    >
                      <span className="w-20 shrink-0 text-sm font-semibold">
                        {formatTime(row.start, timezone)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{row.clientName}</span>
                        <span className="block truncate text-sm text-stone-600">
                          {row.services.join(", ") || "No services"} · {row.locationName}
                        </span>
                        {showStylist ? (
                          <span className="flex items-center gap-1.5 truncate text-xs text-stone-600">
                            <span
                              aria-hidden
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: row.staffColour }}
                            />
                            {row.staffName}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-sm font-medium">{formatMoney(row.totalCents)}</span>
                        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {rows.length >= limit ? (
            <p className="text-center text-sm text-stone-500">
              Showing the first {limit}. Search to narrow it down.
            </p>
          ) : null}
        </div>
      )}

      <BookingSheet
        bookingId={openId}
        timezone={timezone}
        onClose={closeSheet}
        onChanged={refresh}
      />
    </div>
  );
}
