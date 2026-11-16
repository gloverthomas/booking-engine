import { z } from "zod";
import {
  cancelSchema,
  checkoutSchema,
  createBookingSchema,
  reassignSchema,
  rescheduleSchema,
} from "../admin/schemas";
import { clockInSchema, clockOutSchema } from "../timesheets/schemas";
import { offerSlotSchema } from "../waitlist/admin-commands";
import { deviceBody, rosterExceptionBody } from "./bodies";
import * as c from "./contract";
import { googleSignInSchema } from "./session";

/**
 * Every operation of /api/v1: the single list the OpenAPI document is generated from. Tests check it against
 * the route files (nothing undocumented, nothing documented that does not exist) and check real responses
 * against `response`. Regenerate the document with `pnpm openapi`.
 */

type Method = "get" | "post" | "delete";

interface QueryParam {
  name: string;
  required?: boolean;
  schema: z.ZodType;
  description?: string;
}

export interface Operation {
  id: string;
  method: Method;
  /** OpenAPI path under /api/v1, e.g. /bookings/{id}. */
  path: string;
  tag: string;
  summary: string;
  /** Permission needed; "any" for any signed-in team member, "none" for the sign-in call. */
  permission: string;
  query?: QueryParam[];
  body?: z.ZodType;
  /** Null: the success body is `{}`. */
  response: z.ZodType | null;
  status?: number;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.uuid();
const dateRange = [
  { name: "fromDate", required: true, schema: date },
  { name: "toDate", required: true, schema: date },
];
const bookingBody = (schema: z.ZodObject<z.ZodRawShape>) => schema.omit({ bookingId: true });

export const OPERATIONS: Operation[] = [
  {
    id: "signInWithGoogle",
    method: "post",
    path: "/auth/google",
    tag: "Session",
    summary: "Exchange a Google ID token (web or iOS client) for a bearer token",
    permission: "none",
    body: googleSignInSchema,
    response: c.signInResponse,
  },
  {
    id: "signOut",
    method: "post",
    path: "/auth/signout",
    tag: "Session",
    summary: "End the session behind the bearer token",
    permission: "any",
    response: c.signOutResponse,
  },
  {
    id: "me",
    method: "get",
    path: "/me",
    tag: "Session",
    summary: "Who is signed in, their role and permissions",
    permission: "any",
    response: c.meResponse,
  },

  {
    id: "resources",
    method: "get",
    path: "/resources",
    tag: "Booking",
    summary: "Locations, visible stylists, active services and slot size",
    permission: "calendar.viewAll or calendar.viewOwn",
    response: c.resourcesResponse,
  },
  {
    id: "availability",
    method: "get",
    path: "/availability",
    tag: "Booking",
    summary: "Open start times, priced per stylist (max 15 days)",
    permission: "booking.create",
    query: [
      { name: "locationId", required: true, schema: uuid },
      {
        name: "serviceIds",
        required: true,
        schema: z.string(),
        description: "Comma separated service ids",
      },
      ...dateRange.map((p) => ({ ...p, name: p.name === "fromDate" ? "fromDate" : "toDate" })),
      { name: "staffId", schema: uuid, description: "Omit for first available" },
    ],
    response: c.availabilityResponse,
  },
  {
    id: "calendar",
    method: "get",
    path: "/calendar",
    tag: "Booking",
    summary: "Bookings and blocks in a range (max 62 days)",
    permission: "calendar.viewAll or calendar.viewOwn",
    query: [
      { name: "from", required: true, schema: z.iso.datetime({ offset: true }) },
      { name: "to", required: true, schema: z.iso.datetime({ offset: true }) },
      { name: "locationId", schema: uuid },
      { name: "staffIds", schema: z.string(), description: "Comma separated stylist ids" },
    ],
    response: c.calendarResponse,
  },
  {
    id: "listBookings",
    method: "get",
    path: "/bookings",
    tag: "Booking",
    summary: "Booking list",
    permission: "calendar.viewAll or calendar.viewOwn",
    query: [
      { name: "filter", schema: z.enum(["upcoming", "past", "cancelled"]) },
      { name: "q", schema: z.string() },
      { name: "limit", schema: z.number().int().min(1).max(200) },
    ],
    response: c.bookingListResponse,
  },
  {
    id: "createBooking",
    method: "post",
    path: "/bookings",
    tag: "Booking",
    summary: "Create and confirm a booking made by staff",
    permission: "booking.create",
    body: createBookingSchema,
    response: c.createdBookingResponse,
    status: 201,
  },
  {
    id: "getBooking",
    method: "get",
    path: "/bookings/{id}",
    tag: "Booking",
    summary: "Everything about one booking",
    permission: "calendar.viewAll or calendar.viewOwn",
    response: c.bookingDetailResponse,
  },
  {
    id: "cancelBooking",
    method: "post",
    path: "/bookings/{id}/cancel",
    tag: "Booking",
    summary: "Cancel, deciding what happens to the deposit",
    permission: "booking.cancel",
    body: bookingBody(cancelSchema),
    response: c.outcomeResponse,
  },
  {
    id: "rescheduleBooking",
    method: "post",
    path: "/bookings/{id}/reschedule",
    tag: "Booking",
    summary: "Move to a new start time, keeping its length",
    permission: "booking.edit",
    body: bookingBody(rescheduleSchema),
    response: null,
  },
  {
    id: "rescheduleSlots",
    method: "get",
    path: "/bookings/{id}/reschedule-slots",
    tag: "Booking",
    summary: "Times this appointment could move to",
    permission: "booking.edit",
    query: dateRange,
    response: c.rescheduleSlotsResponse,
  },
  {
    id: "reassignBooking",
    method: "post",
    path: "/bookings/{id}/reassign",
    tag: "Booking",
    summary: "Move to another stylist",
    permission: "booking.edit (owner, manager, reception)",
    body: bookingBody(reassignSchema),
    response: null,
  },
  {
    id: "markNoShow",
    method: "post",
    path: "/bookings/{id}/no-show",
    tag: "Booking",
    summary: "Mark a no-show and apply the policy",
    permission: "booking.edit",
    response: c.outcomeResponse,
  },
  {
    id: "checkoutBooking",
    method: "post",
    path: "/bookings/{id}/checkout",
    tag: "Payments",
    summary: "Record a balance paid in cash, EFTPOS or otherwise, and close the booking",
    permission: "checkout",
    body: bookingBody(checkoutSchema),
    response: c.checkoutResponse,
  },
  {
    id: "startCardPayment",
    method: "post",
    path: "/bookings/{id}/card-payment",
    tag: "Payments",
    summary: "Open a Tap to Pay payment for the balance owing",
    permission: "checkout",
    response: c.cardPaymentResponse,
    status: 201,
  },
  {
    id: "cardPaymentStatus",
    method: "get",
    path: "/bookings/{id}/card-payment",
    tag: "Payments",
    summary: "Where a Tap to Pay payment has got to",
    permission: "checkout",
    query: [{ name: "paymentId", required: true, schema: uuid }],
    response: c.cardPaymentStatusResponse,
  },

  {
    id: "searchClients",
    method: "get",
    path: "/clients",
    tag: "Clients",
    summary: "Search clients",
    permission: "clients.view",
    query: [{ name: "q", schema: z.string() }],
    response: c.clientListResponse,
  },
  {
    id: "getClient",
    method: "get",
    path: "/clients/{id}",
    tag: "Clients",
    summary: "Profile, notes and history",
    permission: "clients.view",
    response: c.clientProfileResponse,
  },

  {
    id: "terminalConfig",
    method: "get",
    path: "/payments/terminal",
    tag: "Payments",
    summary: "Whether Tap to Pay is set up, and the Stripe Location",
    permission: "checkout",
    response: c.terminalConfigResponse,
  },
  {
    id: "connectionToken",
    method: "post",
    path: "/payments/terminal/connection-token",
    tag: "Payments",
    summary: "A short-lived secret for the Stripe Terminal SDK",
    permission: "checkout",
    response: c.connectionTokenResponse,
  },

  {
    id: "registerDevice",
    method: "post",
    path: "/devices",
    tag: "Notifications",
    summary: "Register this phone's Expo push token",
    permission: "any",
    body: deviceBody,
    response: c.deviceResponse,
  },
  {
    id: "removeDevice",
    method: "delete",
    path: "/devices",
    tag: "Notifications",
    summary: "Stop notifying this phone",
    permission: "any",
    body: deviceBody,
    response: c.deviceResponse,
  },

  {
    id: "roster",
    method: "get",
    path: "/roster",
    tag: "Roster",
    summary: "Who is working when, Monday to Sunday",
    permission: "roster.viewAll or roster.viewOwn",
    query: [
      { name: "week", schema: date, description: "Any date in the week. Defaults to this week" },
    ],
    response: c.rosterResponse,
  },
  {
    id: "listRosterExceptions",
    method: "get",
    path: "/roster/exceptions",
    tag: "Roster",
    summary: "Days off and changed hours from a date onward",
    permission: "roster.viewAll or roster.viewOwn",
    query: [{ name: "from", schema: date }],
    response: c.exceptionListResponse,
  },
  {
    id: "setRosterException",
    method: "post",
    path: "/roster/exceptions",
    tag: "Roster",
    summary: "Mark a day off, or set different hours for a day",
    permission: "roster.editAll",
    body: rosterExceptionBody,
    response: c.exceptionResultResponse,
    status: 201,
  },
  {
    id: "removeRosterException",
    method: "delete",
    path: "/roster/exceptions/{id}",
    tag: "Roster",
    summary: "Put the stylist back on their weekly hours for that day",
    permission: "roster.editAll",
    response: c.removedResponse,
  },

  {
    id: "clockState",
    method: "get",
    path: "/timesheets/clock",
    tag: "Timesheets",
    summary: "Am I clocked in",
    permission: "timesheets.clock",
    response: c.clockResponse,
  },
  {
    id: "clockIn",
    method: "post",
    path: "/timesheets/clock/in",
    tag: "Timesheets",
    summary: "Start a shift",
    permission: "timesheets.clock",
    body: clockInSchema,
    response: c.clockEntryResponse,
  },
  {
    id: "clockOut",
    method: "post",
    path: "/timesheets/clock/out",
    tag: "Timesheets",
    summary: "End the open shift",
    permission: "timesheets.clock",
    body: clockOutSchema,
    response: c.clockEntryResponse,
  },
  {
    id: "myWeek",
    method: "get",
    path: "/timesheets/week",
    tag: "Timesheets",
    summary: "My week: hours worked against hours rostered",
    permission: "timesheets.viewOwn or timesheets.viewAll",
    query: [{ name: "week", schema: date }],
    response: c.myWeekResponse,
  },

  {
    id: "listWaitlist",
    method: "get",
    path: "/waitlist",
    tag: "Waitlist",
    summary: "Who is waiting for a cancellation",
    permission: "waitlist.manage",
    query: [{ name: "view", schema: z.enum(["active", "history"]) }],
    response: c.waitlistListResponse,
  },
  {
    id: "removeFromWaitlist",
    method: "delete",
    path: "/waitlist/{id}",
    tag: "Waitlist",
    summary: "Take someone off the waitlist",
    permission: "waitlist.manage",
    response: c.removedResponse,
  },
  {
    id: "waitlistSlots",
    method: "get",
    path: "/waitlist/{id}/slots",
    tag: "Waitlist",
    summary: "Open times that suit this person",
    permission: "waitlist.manage",
    response: c.offerableSlotsResponse,
  },
  {
    id: "offerWaitlistSlot",
    method: "post",
    path: "/waitlist/{id}/offer",
    tag: "Waitlist",
    summary: "Offer an open time to this person",
    permission: "waitlist.manage",
    body: offerSlotSchema.omit({ entryId: true }),
    response: c.offerCreatedResponse,
    status: 201,
  },
];

/** The route file an operation lives in, relative to the repo root. */
export function routeFileFor(op: Pick<Operation, "path">): string {
  return `src/app/api/v1${op.path.replace(/\{id\}/g, "[id]")}/route.ts`;
}

const toSchema = (schema: z.ZodType, io: "input" | "output") => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return rest;
};

const envelope = (data: z.ZodType | null) =>
  data
    ? {
        type: "object",
        properties: { data: toSchema(data, "output") },
        required: ["data"],
        additionalProperties: false,
      }
    : {
        type: "object",
        additionalProperties: false,
        description: "Empty: success is the status code",
      };

const ERROR_STATUSES: Record<string, string> = {
  "400": "The request was refused with a message to show",
  "401": "Not signed in, or the session ended",
  "403": "Signed in, but this role may not do that",
  "404": "Not found, or not yours",
  "409": "Conflicts with the current state (slot taken, already clocked in, ...)",
  "422": "Invalid input; `error.fields` names the fields",
  "503": "A server setup step (Google or Stripe) is not finished",
};

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATIONS) {
    const parameters = [
      ...(op.path.includes("{id}")
        ? [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }]
        : []),
      ...(op.query ?? []).map((q) => ({
        name: q.name,
        in: "query",
        required: q.required ?? false,
        ...(q.description ? { description: q.description } : {}),
        schema: toSchema(q.schema, "input"),
      })),
    ];
    const success = String(op.status ?? 200);
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      description: `Permission: ${op.permission}.`,
      ...(op.permission === "none" ? { security: [] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: toSchema(op.body, "input") } },
            },
          }
        : {}),
      responses: {
        [success]: {
          description: "Success",
          content: { "application/json": { schema: envelope(op.response) } },
        },
        ...Object.fromEntries(
          Object.entries(ERROR_STATUSES).map(([code, description]) => [
            code,
            {
              description,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          ]),
        ),
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "HairMate staff API",
      version: "1.0.0",
      description:
        "The API behind the HairMate iPhone app. Success is `{ data }`; failure is `{ error: { code, message, fields? } }` with a real HTTP status. Generated from src/server/api/openapi.ts: run `pnpm openapi` after changing an endpoint.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Token from POST /auth/google" },
      },
      schemas: { Error: toSchema(c.errorResponse, "output") },
    },
  };
}
