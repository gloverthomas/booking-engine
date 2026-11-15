import { DateTime } from "luxon";
import type { TimeSlot } from "@/server/contracts";
import type { AvailabilityDay, SlotDto } from "./public-api-types";

/** Local hour at which "morning" ends and "afternoon" (including evening) begins. */
export const AFTERNOON_STARTS_HOUR = 12;

/** Optional extras added to each slot, e.g. who it is with and their price. */
export type SlotAnnotator<T extends TimeSlot> = (slot: T) => Partial<SlotDto>;

function toDto(slot: TimeSlot, zone: string, extra: Partial<SlotDto>): SlotDto {
  const local = DateTime.fromJSDate(slot.start, { zone });
  return {
    ...extra,
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    label: local.toFormat("h:mm a").toLowerCase(),
  };
}

/**
 * Group slots by local calendar day in `zone`, split into morning/afternoon. Duplicate start
 * times (several stylists free at once) collapse to one entry because the client picks a time,
 * not a person. Output is sorted and only contains days that have slots.
 */
export function groupSlotsByLocalDay<T extends TimeSlot>(
  slots: readonly T[],
  zone: string,
  annotate?: SlotAnnotator<T>,
): AvailabilityDay[] {
  const seen = new Set<number>();
  const days = new Map<string, { morning: SlotDto[]; afternoon: SlotDto[] }>();

  const ordered = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const slot of ordered) {
    const ms = slot.start.getTime();
    if (seen.has(ms)) continue;
    seen.add(ms);

    const local = DateTime.fromJSDate(slot.start, { zone });
    const date = local.toFormat("yyyy-MM-dd");
    const bucket = days.get(date) ?? { morning: [], afternoon: [] };
    (local.hour < AFTERNOON_STARTS_HOUR ? bucket.morning : bucket.afternoon).push(
      toDto(slot, zone, annotate?.(slot) ?? {}),
    );
    days.set(date, bucket);
  }

  return [...days.entries()].map(([date, bucket]) => ({ date, ...bucket }));
}

/** Local `YYYY-MM-DD` for "now" in the business zone. */
export function todayIn(zone: string, now: Date): string {
  return DateTime.fromJSDate(now, { zone }).toFormat("yyyy-MM-dd");
}
