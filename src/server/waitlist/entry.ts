import { eq, inArray } from "drizzle-orm";
import { location, service, staff, waitlistEntry } from "@/db/schema";
import { getBusinessContext } from "../availability/context";
import { isUuid } from "../booking/shared";
import type { Db } from "../db-types";
import { makeManageToken, verifyManageToken } from "../manage-token";
import { cancelWaitlistEntry } from "./join";
import { resolveKey, type WaitlistOptions } from "./shared";
import type { EntryRow } from "./shared";

/** The link that lets a client leave the waitlist. Stateless: rebuilt from the entry id any time. */
export function makeLeaveToken(entryId: string, options: WaitlistOptions = {}): string {
  return makeManageToken(entryId, resolveKey(options));
}

export interface WaitlistEntryView {
  entryId: string;
  status: EntryRow["status"];
  locationName: string;
  staffName: string | null;
  serviceNames: string[];
  earliestDate: string;
  latestDate: string;
  weekdays: number[] | null;
  fromMinute: number | null;
  toMinute: number | null;
  timezone: string;
}

function entryIdOf(token: string, options: WaitlistOptions): string | null {
  const id = verifyManageToken(token, resolveKey(options));
  return id && isUuid(id) ? id : null;
}

/** What the leave page shows, or null when the link is not authentic or the entry is gone. */
export async function getEntryByToken(
  db: Db,
  token: string,
  options: WaitlistOptions = {},
): Promise<WaitlistEntryView | null> {
  const entryId = entryIdOf(token, options);
  if (!entryId) return null;
  const [entry] = await db.select().from(waitlistEntry).where(eq(waitlistEntry.id, entryId));
  if (!entry) return null;

  const [loc] = await db.select().from(location).where(eq(location.id, entry.locationId));
  const [stylist] = entry.staffId
    ? await db.select({ name: staff.name }).from(staff).where(eq(staff.id, entry.staffId))
    : [undefined];
  const services = await db
    .select({ id: service.id, name: service.name })
    .from(service)
    .where(inArray(service.id, entry.serviceIds));
  const byId = new Map(services.map((s) => [s.id, s.name]));
  const context = await getBusinessContext(db, entry.locationId);

  return {
    entryId: entry.id,
    status: entry.status,
    locationName: loc?.name ?? "",
    staffName: stylist?.name ?? null,
    serviceNames: entry.serviceIds.map((id) => byId.get(id)).filter((n): n is string => !!n),
    earliestDate: entry.earliestDate,
    latestDate: entry.latestDate,
    weekdays: entry.weekdays,
    fromMinute: entry.fromMinute,
    toMinute: entry.toMinute,
    timezone: context.timezone,
  };
}

/** Leave the waitlist from the emailed or texted link. Idempotent; false when the link is not valid. */
export async function leaveWaitlistByToken(
  db: Db,
  token: string,
  options: WaitlistOptions & { now?: Date } = {},
): Promise<boolean> {
  const entryId = entryIdOf(token, options);
  if (!entryId) return false;
  const [entry] = await db
    .select({ id: waitlistEntry.id })
    .from(waitlistEntry)
    .where(eq(waitlistEntry.id, entryId));
  if (!entry) return false;
  await cancelWaitlistEntry(db, entryId, "client", { now: options.now });
  return true;
}
