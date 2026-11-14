import { describe, expect, test } from "vitest";
import { parseIntegrationBanner } from "@/server/admin-foundation/integration-banner";

describe("parseIntegrationBanner", () => {
  test("shows a success banner for a connected provider", () => {
    expect(parseIntegrationBanner({ integration: "xero", status: "connected" })).toEqual({
      provider: "xero",
      tone: "success",
      text: "Xero is connected.",
    });
  });

  test("shows an error banner with a length-capped message", () => {
    const banner = parseIntegrationBanner({
      integration: "google",
      status: "error",
      message: "x".repeat(500),
    });
    expect(banner?.tone).toBe("danger");
    expect(banner?.text.length).toBeLessThan(260);
    expect(parseIntegrationBanner({ integration: "google", status: "error" })?.text).toBe(
      "Could not connect Google Calendar.",
    );
  });

  test("ignores unknown providers, statuses and missing params; takes the first of repeated params", () => {
    expect(parseIntegrationBanner({})).toBeNull();
    expect(parseIntegrationBanner({ integration: "stripe", status: "connected" })).toBeNull();
    expect(parseIntegrationBanner({ integration: "xero", status: "weird" })).toBeNull();
    expect(
      parseIntegrationBanner({ integration: ["google", "xero"], status: ["connected"] })?.provider,
    ).toBe("google");
  });
});
