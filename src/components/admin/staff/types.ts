import type { StaffListItem } from "@/server/staff/queries";

/** A staff row plus the display strings the server prepared, so the client never formats dates. */
export interface StaffRowView extends Omit<StaffListItem, "google"> {
  google: {
    status: "connected" | "error" | "disconnected";
    calendar: string | null;
    lastSyncText: string | null;
    lastError: string | null;
  } | null;
}
