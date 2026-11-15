import { systemClock, type Clock } from "../clock";
import type { Db } from "../db-types";
import { getClockState } from "./clock";
import { formatClockTime } from "./time";

/** What the Clock widget fetches. Dates are ISO strings; `sinceLabel` is already in business-local time. */
export type ClockPayload =
  | { available: false }
  | {
      available: true;
      /** The server's clock, so elapsed time is right even if the phone's clock is off. */
      serverNow: string;
      open: {
        since: string;
        sinceLabel: string;
        locationName: string | null;
      } | null;
      locations: Array<{ id: string; name: string }>;
    };

/** Null staffId (an owner with no staff profile) means there is no timesheet to clock into. */
export async function buildClockPayload(
  db: Db,
  input: { staffId: string | null; timezone: string },
  clock: Clock = systemClock,
): Promise<ClockPayload> {
  if (!input.staffId) return { available: false };
  const state = await getClockState(db, input.staffId);
  return {
    available: true,
    serverNow: clock().toISOString(),
    open: state.open
      ? {
          since: state.open.clockIn.toISOString(),
          sinceLabel: formatClockTime(state.open.clockIn, input.timezone),
          locationName: state.open.locationName,
        }
      : null,
    locations: state.locations,
  };
}
