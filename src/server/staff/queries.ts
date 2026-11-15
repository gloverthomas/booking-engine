import { and, asc, desc, eq } from "drizzle-orm";
import { integrationAccount, staff } from "@/db/schema";
import type { Db } from "@/server/db-types";

export type GoogleCalendarState = "connected" | "error" | "disconnected";

export interface GoogleCalendarStatus {
  status: GoogleCalendarState;
  /** The Google calendar id, when connected. */
  calendar: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export interface StaffListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: "owner" | "manager" | "stylist" | "reception";
  level: number;
  colour: string | null;
  active: boolean;
  /** True once they have signed in with Google at least once. */
  hasSignedIn: boolean;
  /** Null when this person has no Google Calendar link at all. */
  google: GoogleCalendarStatus | null;
}

/**
 * Everyone on the team, active people first. Reads each person's Google Calendar link but never the
 * encrypted tokens.
 */
export async function listStaff(db: Db): Promise<StaffListItem[]> {
  const rows = await db
    .select({
      id: staff.id,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role,
      level: staff.level,
      colour: staff.colour,
      active: staff.active,
      userId: staff.userId,
      googleStatus: integrationAccount.status,
      googleCalendar: integrationAccount.externalAccountId,
      googleLastSyncAt: integrationAccount.lastSyncAt,
      googleLastError: integrationAccount.lastError,
      googleId: integrationAccount.id,
    })
    .from(staff)
    .leftJoin(
      integrationAccount,
      and(eq(integrationAccount.staffId, staff.id), eq(integrationAccount.provider, "google")),
    )
    .orderBy(desc(staff.active), asc(staff.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    level: row.level,
    colour: row.colour,
    active: row.active,
    hasSignedIn: row.userId !== null,
    google:
      row.googleId === null || row.googleStatus === null
        ? null
        : {
            status: row.googleStatus,
            calendar: row.googleCalendar,
            lastSyncAt: row.googleLastSyncAt,
            lastError: row.googleLastError,
          },
  }));
}
