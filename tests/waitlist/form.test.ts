import { describe, expect, test, vi } from "vitest";
import {
  buildJoinRequest,
  initialForm,
  joinWaitlistHref,
  toggleWeekday,
  validateJoin,
} from "@/components/public/waitlist/form";
import { createWaitlistClient } from "@/components/public/waitlist/waitlist-api";

const TODAY = "2026-11-01";
const HORIZON = "2027-01-30";

const valid = {
  ...initialForm(TODAY),
  firstName: "Sam",
  lastName: "Client",
  email: "sam@example.com",
  phone: "0412 345 678",
};

describe("initialForm", () => {
  test("starts on the day they were looking at, for two weeks", () => {
    expect(initialForm(TODAY, "2026-11-10")).toMatchObject({
      earliestDate: "2026-11-10",
      latestDate: "2026-11-24",
    });
  });
  test("falls back to today for a missing, bad or past date", () => {
    for (const date of [undefined, "nope", "2026-10-01"]) {
      expect(initialForm(TODAY, date).earliestDate).toBe(TODAY);
    }
  });
});

describe("toggleWeekday", () => {
  test("adds in order and removes", () => {
    expect(toggleWeekday([3], 1)).toEqual([1, 3]);
    expect(toggleWeekday([1, 3], 1)).toEqual([3]);
  });
});

describe("validateJoin", () => {
  test("accepts a complete form", () => {
    expect(validateJoin(valid, TODAY, HORIZON)).toEqual({});
  });

  test("flags missing and malformed fields", () => {
    const errors = validateJoin(
      { ...valid, firstName: "", lastName: " ", email: "x", phone: "12" },
      TODAY,
      HORIZON,
    );
    expect(Object.keys(errors).sort()).toEqual([
      "client.email",
      "client.firstName",
      "client.lastName",
      "client.phone",
    ]);
    expect(validateJoin({ ...valid, email: "", phone: "" }, TODAY, HORIZON)).toMatchObject({
      "client.email": "Email is required",
      "client.phone": "Mobile number is required",
    });
  });

  test("checks the date window", () => {
    expect(
      validateJoin({ ...valid, earliestDate: "2026-10-01" }, TODAY, HORIZON).earliestDate,
    ).toBe("That date has passed");
    expect(validateJoin({ ...valid, earliestDate: "" }, TODAY, HORIZON).earliestDate).toBeTruthy();
    expect(validateJoin({ ...valid, latestDate: "" }, TODAY, HORIZON).latestDate).toBeTruthy();
    expect(
      validateJoin({ ...valid, latestDate: "2028-01-01" }, TODAY, HORIZON).latestDate,
    ).toContain(HORIZON);
    expect(
      validateJoin(
        { ...valid, earliestDate: "2026-11-10", latestDate: "2026-11-05" },
        TODAY,
        HORIZON,
      ).latestDate,
    ).toContain("can't be before");
  });
});

describe("buildJoinRequest", () => {
  test("trims, omits empty weekdays and carries the selection", () => {
    const request = buildJoinRequest(
      { ...valid, firstName: " Sam ", timeOfDay: "morning" },
      { locationId: "L", serviceIds: ["S"], staffId: "T" },
      "tok",
    );
    expect(request).toMatchObject({
      client: { firstName: "Sam", email: "sam@example.com", marketingOptIn: false },
      locationId: "L",
      staffId: "T",
      serviceIds: ["S"],
      weekdays: undefined,
      timeOfDay: "morning",
      turnstileToken: "tok",
    });
    expect(
      buildJoinRequest({ ...valid, weekdays: [1] }, { locationId: "L", serviceIds: ["S"] })
        .weekdays,
    ).toEqual([1]);
  });
});

describe("joinWaitlistHref", () => {
  test("carries location, services, date and staff", () => {
    expect(
      joinWaitlistHref({
        locationId: "L",
        serviceIds: ["a", "b"],
        date: "2026-11-02",
        staffId: "T",
      }),
    ).toBe("/waitlist/join?location=L&services=a%2Cb&date=2026-11-02&staff=T");
    expect(joinWaitlistHref({ locationId: "L", serviceIds: ["a"] })).toBe(
      "/waitlist/join?location=L&services=a",
    );
  });
});

describe("waitlist client", () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  test("returns data from the envelope and posts JSON", async () => {
    const fetchImpl = respond({ success: true, data: { left: true } });
    const client = createWaitlistClient(fetchImpl as unknown as typeof fetch);
    expect(await client.leave("a.b")).toEqual({ ok: true, data: { left: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/waitlist/entries/a.b/leave");
    expect(init.method).toBe("POST");
  });

  test("returns structured errors, and never throws", async () => {
    const failing = createWaitlistClient(
      respond({ success: false, error: { code: "offer_gone", message: "Gone" } }, 410) as never,
    );
    expect(await failing.offer("t")).toEqual({
      ok: false,
      status: 410,
      error: { code: "offer_gone", message: "Gone" },
    });
    const network = createWaitlistClient((async () => {
      throw new Error("down");
    }) as never);
    expect((await network.entry("t")).ok).toBe(false);
    const garbage = createWaitlistClient(
      (async () => new Response("<html>", { status: 502 })) as never,
    );
    expect(await garbage.claim("t", "1")).toMatchObject({ ok: false, status: 502 });
    const odd = createWaitlistClient(respond({ nope: true }) as never);
    expect(await odd.entry("t")).toMatchObject({ ok: false, error: { code: "bad_response" } });
    const oddError = createWaitlistClient(respond({ success: false, error: 5 }, 400) as never);
    expect(await oddError.entry("t")).toMatchObject({ ok: false, error: { code: "bad_response" } });
  });
});
