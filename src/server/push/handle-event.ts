import { eq } from "drizzle-orm";
import { z } from "zod";
import { booking } from "@/db/schema";
import { isImportedSource } from "../import/constants";
import type { Db } from "../db-types";
import { loadBookingContext } from "../notifications/booking-context";
import { shortDate, shortTime } from "../notifications/format";
import { ownerIds, removeDeadTokens, tokensFor } from "./devices";
import type { PushMessage, PushSender } from "./expo";

export interface PushContext {
  db: Db;
  sender: PushSender;
  log: (entry: Record<string, unknown>) => void;
}

const bookingEvent = z.object({ bookingId: z.string() });
const cancelledEvent = bookingEvent.extend({ by: z.enum(["client", "staff"]) });

/** Bookings the staff made themselves, and imports, are not news to anyone. */
const isClientMade = (source: string) => source !== "admin" && !isImportedSource(source);

type Kind = "new" | "cancelled";
const TITLE: Record<Kind, string> = { new: "New booking", cancelled: "Booking cancelled" };

/**
 * Turn a domain event into notifications on the phones of the people who should hear about it: the
 * stylist the booking is with, and the owners. Client first name only, never contact details, matching the
 * SMS alerts. Returns how many notifications were sent.
 */
export async function handlePushEvent(
  ctx: PushContext,
  data: Record<string, unknown>,
): Promise<number> {
  switch (data.type) {
    case "booking.confirmed": {
      const parsed = bookingEvent.safeParse(data);
      return parsed.success ? notify(ctx, parsed.data.bookingId, "new") : 0;
    }
    case "booking.cancelled": {
      const parsed = cancelledEvent.safeParse(data);
      // A stylist cancelling their own booking in the app does not need telling.
      return parsed.success && parsed.data.by === "client"
        ? notify(ctx, parsed.data.bookingId, "cancelled")
        : 0;
    }
    default:
      return 0;
  }
}

async function notify(ctx: PushContext, bookingId: string, kind: Kind): Promise<number> {
  const { db } = ctx;
  const [row] = await db
    .select({ source: booking.source, staffId: booking.staffId })
    .from(booking)
    .where(eq(booking.id, bookingId));
  if (!row || !isClientMade(row.source)) return 0;

  const info = await loadBookingContext(db, bookingId);
  if (!info || !info.settings.staffAlertsEnabled) return 0;

  const people = [...new Set([row.staffId, ...(await ownerIds(db))])];
  const tokens = await tokensFor(db, people);
  if (tokens.length === 0) return 0;

  const when = `${shortDate(info.start, info.timezone)} ${shortTime(info.start, info.timezone)}`;
  const body = `${info.client.firstName} · ${info.services.map((s) => s.name).join(", ")} · ${when}`;
  const messages: PushMessage[] = tokens.map((to) => ({
    to,
    title: TITLE[kind],
    body,
    data: { bookingId, kind },
  }));

  const tickets = await ctx.sender.send(messages);
  const dead = tickets.flatMap((t, i) =>
    t.status === "error" && t.error === "DeviceNotRegistered" ? [messages[i].to] : [],
  );
  await removeDeadTokens(db, dead);
  const failed = tickets.filter((t) => t.status === "error" && t.error !== "DeviceNotRegistered");
  if (failed.length > 0) ctx.log({ event: "push_failed", bookingId, kind, count: failed.length });
  return tickets.length - dead.length - failed.length;
}
