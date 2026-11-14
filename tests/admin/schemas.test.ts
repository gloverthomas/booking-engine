import { describe, expect, test } from "vitest";
import {
  blockSchema,
  calendarQuerySchema,
  cancelSchema,
  clientSearchQuerySchema,
  queryToObject,
  checkoutSchema,
  createBookingSchema,
  mergeSchema,
  notesSchema,
  rescheduleSchema,
} from "@/server/admin/schemas";

const id = "5c9f5f0e-6a38-4d0e-8f5c-2b0d4b6b6b11";
const id2 = "0b6a2d4e-1f4c-4a56-9d51-7c1f3a9a8d22";

describe("createBookingSchema", () => {
  const base = {
    locationId: id,
    serviceIds: [id2],
    start: "2026-11-16T03:00:00.000Z",
    notifyClient: true,
  };

  test("parses an existing client booking and turns the start into a Date", () => {
    const parsed = createBookingSchema.parse({ ...base, client: { existingClientId: id2 } });
    expect(parsed.start).toBeInstanceOf(Date);
    expect(parsed.client).toEqual({ existingClientId: id2 });
  });

  test("normalises an Australian mobile number to E.164", () => {
    const parsed = createBookingSchema.parse({
      ...base,
      client: {
        newClient: { firstName: " Jo ", lastName: "Smith", phone: "0411 222 333", email: "" },
      },
    });
    expect(parsed.client).toEqual({
      newClient: { firstName: "Jo", lastName: "Smith", phone: "+61411222333", email: "" },
    });
  });

  test("rejects a bad phone, bad email and no services", () => {
    const newClient = { firstName: "Jo", lastName: "", phone: "12", email: "" };
    expect(createBookingSchema.safeParse({ ...base, client: { newClient } }).success).toBe(false);
    expect(
      createBookingSchema.safeParse({
        ...base,
        client: { newClient: { ...newClient, phone: "0411222333", email: "nope" } },
      }).success,
    ).toBe(false);
    expect(
      createBookingSchema.safeParse({ ...base, serviceIds: [], client: { existingClientId: id } })
        .success,
    ).toBe(false);
  });

  test("a new client needs a first name", () => {
    const result = createBookingSchema.safeParse({
      ...base,
      client: { newClient: { firstName: " ", lastName: "", phone: "0411222333", email: "" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("other schemas", () => {
  test("reschedule needs a valid id and ISO date", () => {
    expect(
      rescheduleSchema.parse({
        bookingId: id,
        newStart: "2026-11-16T03:00:00Z",
        notifyClient: false,
      }).newStart,
    ).toBeInstanceOf(Date);
    expect(
      rescheduleSchema.safeParse({
        bookingId: "x",
        newStart: "2026-11-16T03:00:00Z",
        notifyClient: true,
      }).success,
    ).toBe(false);
    expect(
      rescheduleSchema.safeParse({ bookingId: id, newStart: "tomorrow", notifyClient: true })
        .success,
    ).toBe(false);
  });

  test("cancel restricts the deposit mode and trims the reason", () => {
    expect(
      cancelSchema.parse({ bookingId: id, depositMode: "keep", reason: "  rain " }).reason,
    ).toBe("rain");
    expect(cancelSchema.safeParse({ bookingId: id, depositMode: "free" }).success).toBe(false);
  });

  test("block must end after it starts", () => {
    const ok = blockSchema.safeParse({
      staffId: id,
      start: "2026-11-16T03:00:00Z",
      end: "2026-11-16T04:00:00Z",
    });
    expect(ok.success).toBe(true);
    const bad = blockSchema.safeParse({
      staffId: id,
      start: "2026-11-16T04:00:00Z",
      end: "2026-11-16T03:00:00Z",
    });
    expect(bad.success).toBe(false);
  });

  test("checkout only accepts manual payment methods", () => {
    expect(checkoutSchema.safeParse({ bookingId: id, method: "cash" }).success).toBe(true);
    expect(checkoutSchema.safeParse({ bookingId: id, method: "stripe_online" }).success).toBe(
      false,
    );
  });

  test("notes are capped and merge ids are uuids", () => {
    expect(notesSchema.safeParse({ clientId: id, notes: "x".repeat(4001) }).success).toBe(false);
    expect(notesSchema.safeParse({ clientId: id, notes: "" }).success).toBe(true);
    expect(mergeSchema.safeParse({ keepClientId: id, duplicateClientId: "nope" }).success).toBe(
      false,
    );
  });
});

describe("read query schemas", () => {
  test("calendar query parses dates and optional filters", () => {
    const params = new URLSearchParams({
      from: "2026-11-15T00:00:00.000Z",
      to: "2026-11-22T00:00:00.000Z",
      locationId: "",
      staffId: id,
    });
    const parsed = calendarQuerySchema.parse(queryToObject(params));
    expect(parsed.from).toBeInstanceOf(Date);
    expect(parsed.locationId).toBeUndefined();
    expect(parsed.staffId).toBe(id);
  });

  test("calendar query rejects reversed or huge ranges", () => {
    expect(
      calendarQuerySchema.safeParse({ from: "2026-11-22T00:00:00Z", to: "2026-11-15T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(
      calendarQuerySchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" })
        .success,
    ).toBe(false);
  });

  test("client search defaults to an empty query and caps length", () => {
    expect(clientSearchQuerySchema.parse({}).q).toBe("");
    expect(clientSearchQuerySchema.parse({ q: "  jo " }).q).toBe("jo");
    expect(clientSearchQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });
});
