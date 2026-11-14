import { describe, expect, it } from "vitest";
import {
  availabilityQuerySchema,
  fieldErrorsFrom,
  holdBodySchema,
  phoneSchema,
  rescheduleBodySchema,
} from "@/lib/public-api-schemas";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const validHold = {
  locationId: A,
  serviceIds: [B],
  start: "2026-11-20T03:30:00.000Z",
  client: {
    firstName: "  Sam ",
    lastName: "Client",
    email: "  Sam@Example.COM ",
    phone: "0410 123 456",
  },
  policyVersion: "1",
  policyAccepted: true,
};

describe("phoneSchema", () => {
  it("normalises Australian mobiles to E.164", () => {
    expect(phoneSchema.parse("0410 123 456")).toBe("+61410123456");
    expect(phoneSchema.parse("+61 410 123 456")).toBe("+61410123456");
  });
  it("rejects nonsense", () => {
    expect(phoneSchema.safeParse("12345").success).toBe(false);
    expect(phoneSchema.safeParse("").success).toBe(false);
  });
});

describe("availabilityQuerySchema", () => {
  const base = {
    locationId: A,
    serviceIds: `${A},${B}`,
    fromDate: "2026-11-01",
    toDate: "2026-11-30",
  };

  it("parses comma separated service ids", () => {
    const parsed = availabilityQuerySchema.parse(base);
    expect(parsed.serviceIds).toEqual([A, B]);
    expect(parsed.staffId).toBeUndefined();
  });

  it("rejects reversed and oversized ranges", () => {
    expect(availabilityQuerySchema.safeParse({ ...base, fromDate: "2026-12-01" }).success).toBe(
      false,
    );
    expect(availabilityQuerySchema.safeParse({ ...base, toDate: "2027-03-01" }).success).toBe(
      false,
    );
  });

  it("rejects missing services and bad ids", () => {
    expect(availabilityQuerySchema.safeParse({ ...base, serviceIds: "" }).success).toBe(false);
    expect(availabilityQuerySchema.safeParse({ ...base, serviceIds: "abc" }).success).toBe(false);
    expect(availabilityQuerySchema.safeParse({ ...base, fromDate: "2026-02-30" }).success).toBe(
      false,
    );
  });
});

describe("holdBodySchema", () => {
  it("normalises names, email and phone and applies defaults", () => {
    const parsed = holdBodySchema.parse(validHold);
    expect(parsed.client.firstName).toBe("Sam");
    expect(parsed.client.email).toBe("sam@example.com");
    expect(parsed.client.phone).toBe("+61410123456");
    expect(parsed.client.marketingOptIn).toBe(false);
    expect(parsed.bookedForOther).toBe(false);
    expect(parsed.intakeAnswers).toEqual({});
  });

  it("normalises the optional second phone", () => {
    const parsed = holdBodySchema.parse({ ...validHold, otherPhone: "03 9123 4567" });
    expect(parsed.otherPhone).toBe("+61391234567");
    expect(holdBodySchema.parse({ ...validHold, otherPhone: "" }).otherPhone).toBeUndefined();
    expect(holdBodySchema.safeParse({ ...validHold, otherPhone: "xx" }).success).toBe(false);
  });

  it("requires the policy to be accepted", () => {
    const result = holdBodySchema.safeParse({ ...validHold, policyAccepted: false });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrorsFrom(result.error).policyAccepted).toMatch(/cancellation policy/);
    }
  });

  it("reports field-level messages", () => {
    const result = holdBodySchema.safeParse({
      ...validHold,
      client: { ...validHold.client, email: "nope", firstName: "" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = fieldErrorsFrom(result.error);
      expect(errors["client.email"]).toBe("Enter a valid email address");
      expect(errors["client.firstName"]).toBe("First name is required");
    }
  });

  it("rejects an empty service list and a malformed start", () => {
    expect(holdBodySchema.safeParse({ ...validHold, serviceIds: [] }).success).toBe(false);
    expect(holdBodySchema.safeParse({ ...validHold, start: "tomorrow" }).success).toBe(false);
  });
});

describe("rescheduleBodySchema", () => {
  it("accepts an ISO instant", () => {
    expect(rescheduleBodySchema.safeParse({ start: "2026-11-20T03:30:00Z" }).success).toBe(true);
    expect(rescheduleBodySchema.safeParse({ start: "x" }).success).toBe(false);
  });
});
