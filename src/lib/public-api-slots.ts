import { DateTime } from "luxon";
import type { TimeSlot } from "@/server/contracts";
import type { AvailabilityDay, SlotDto } from "./public-api-types";

/** Local hour at which "morning" ends and "afternoon" (including evening) begins. */
export const AFTERNOON_STARTS_HOUR = 12;

function toDto(slot: TimeSlot, zone: string): SlotDto {
  const local = DateTime.fromJSDate(slot.start, { zone });
  return {
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
export function groupSlotsByLocalDay(slots: readonly TimeSlot[], zone: string): AvailabilityDay[] {
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
      toDto(slot, zone),
    );
    days.set(date, bucket);
  }

  return [...days.entries()].map(([date, bucket]) => ({ date, ...bucket }));
}

/** Local `YYYY-MM-DD` for "now" in the business zone. */
export function todayIn(zone: string, now: Date): string {
  return DateTime.fromJSDate(now, { zone }).toFormat("yyyy-MM-dd");
}
