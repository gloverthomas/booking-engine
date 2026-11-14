import { describe, expect, test } from "vitest";
import {
  formatMoney,
  longDate,
  longTime,
  shortDate,
  shortTime,
} from "@/server/notifications/format";
import { isE164, measureSms, toAsciiSafe } from "@/server/notifications/sms-text";

describe("E.164 validation", () => {
  test.each(["+61410123456", "+14155552671", "+442071838750"])("accepts %s", (phone) => {
    expect(isE164(phone)).toBe(true);
  });

  test.each(["0410123456", "61410123456", "+0410123456", "+61 410 123 456", "", "+1"])(
    "rejects %j",
    (phone) => {
      expect(isE164(phone)).toBe(false);
    },
  );
});

describe("toAsciiSafe", () => {
  test("replaces smart punctuation and strips accents and emoji", () => {
    expect(toAsciiSafe("Zoë’s “cut” – 2:15PM… ✂️")).toBe('Zoe\'s "cut" - 2:15PM...');
  });

  test("collapses repeated spaces and non-breaking spaces", () => {
    expect(toAsciiSafe("a  b   c")).toBe("a b c");
  });
});

describe("measureSms", () => {
  test("counts a short message as one segment", () => {
    expect(measureSms("Hello")).toEqual({ length: 5, segments: 1 });
  });

  test("exactly 160 characters is one segment, 161 is two", () => {
    expect(measureSms("a".repeat(160)).segments).toBe(1);
    expect(measureSms("a".repeat(161)).segments).toBe(2);
    expect(measureSms("a".repeat(306)).segments).toBe(2);
    expect(measureSms("a".repeat(307)).segments).toBe(3);
  });

  test("extension characters cost two", () => {
    expect(measureSms("[x]").length).toBe(5);
  });

  test("empty message has no segments", () => {
    expect(measureSms("").segments).toBe(0);
  });
});

describe("date and money formatting in the business timezone", () => {
  // 03:15Z on 14 Nov is 14:15 in Melbourne (daylight saving, UTC+11).
  const start = new Date("2026-11-14T03:15:00.000Z");

  test("short formats for SMS", () => {
    expect(shortDate(start, "Australia/Melbourne")).toBe("Sat, 14 Nov");
    expect(shortTime(start, "Australia/Melbourne")).toBe("2:15PM");
  });

  test("long formats for email", () => {
    expect(longDate(start, "Australia/Melbourne")).toBe("Saturday 14 November 2026");
    expect(longTime(start, "Australia/Melbourne")).toBe("2:15 PM");
  });

  test("a late-evening UTC time lands on the next local day", () => {
    const lateUtc = new Date("2026-11-13T20:00:00.000Z");
    expect(shortDate(lateUtc, "Australia/Melbourne")).toBe("Sat, 14 Nov");
    expect(shortTime(lateUtc, "Australia/Melbourne")).toBe("7:00AM");
  });

  test("winter time uses AEST (UTC+10)", () => {
    expect(shortTime(new Date("2026-07-01T04:00:00.000Z"), "Australia/Melbourne")).toBe("2:00PM");
  });

  test("an invalid time zone fails loudly", () => {
    expect(() => shortDate(start, "Not/AZone")).toThrow(/Cannot format date/);
  });

  test("formats money as dollars and cents", () => {
    expect(formatMoney(9500)).toBe("$95.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(-250)).toBe("-$2.50");
  });
});
