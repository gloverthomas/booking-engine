import { DateTime } from "luxon";
import type { StaffListItem } from "@/server/staff/queries";
import type { StaffRowView } from "./types";

/** Turns query rows into client-safe rows, formatting times in the business time zone. */
export function toStaffRowViews(
  people: readonly StaffListItem[],
  timezone: string,
): StaffRowView[] {
  return people.map(({ google, ...person }) => ({
    ...person,
    google: google
      ? {
          status: google.status,
          calendar: google.calendar,
          lastError: google.lastError,
          lastSyncText: google.lastSyncAt
            ? DateTime.fromJSDate(google.lastSyncAt, { zone: timezone }).toFormat(
                "ccc d LLL, h:mm a",
              )
            : null,
        }
      : null,
  }));
}
