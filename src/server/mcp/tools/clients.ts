import { z } from "zod";
import { defineRead } from "../deps";
import { loadClient, loadClientBookings, searchClients } from "../queries";
import { idSchema, whenOut } from "../shared";
import { personName, untrusted } from "../text";

export const findClient = defineRead({
  kind: "read",
  name: "find_client",
  title: "Find client",
  description:
    "Search clients by name, email or phone (partial matches). Returns at most 10, with ids to use in other tools.",
  schema: z.object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .describe("Part of a name, email address or phone number."),
  }),
  async run({ query }, { deps }) {
    const rows = await searchClients(deps.db, query, 10);
    return {
      count: rows.length,
      clients: rows.map((c) => ({
        clientId: c.id,
        name: untrusted(personName(c.firstName, c.lastName), 120),
        email: untrusted(c.email, 200),
        phone: untrusted(c.phone, 40),
        isVip: c.isVip,
        blocked: c.blocked,
      })),
    };
  },
});

export const getClientHistory = defineRead({
  kind: "read",
  name: "get_client_history",
  title: "Get client history",
  description:
    "One client's details, notes and booking history (newest first) with a count of completed visits and no-shows.",
  schema: z.object({
    clientId: idSchema,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async run({ clientId, limit }, { deps, timezone }) {
    const c = await loadClient(deps.db, clientId);
    const history = await loadClientBookings(deps.db, clientId, limit);
    const count = (status: string) => history.filter((h) => h.status === status).length;
    return {
      client: {
        clientId: c.id,
        name: untrusted(personName(c.firstName, c.lastName), 120),
        email: untrusted(c.email, 200),
        phone: untrusted(c.phone, 40),
        pronouns: untrusted(c.pronouns, 60),
        isVip: c.isVip,
        blocked: c.blocked,
        marketingOptIn: c.marketingOptIn,
        notes: untrusted(c.notes, 2000),
        mergedInto: c.mergedIntoId,
      },
      summary: {
        bookingsShown: history.length,
        completed: count("completed"),
        noShows: count("no_show"),
        lateCancels: count("late_cancelled"),
        upcoming: history.filter((h) => h.status === "confirmed" && h.during.start > deps.now())
          .length,
      },
      bookings: history.map((h) => ({
        bookingId: h.bookingId,
        status: h.status,
        start: whenOut(h.during.start, timezone),
        location: h.locationName,
        services: h.services,
        totalCents: h.totalCents,
      })),
    };
  },
});
