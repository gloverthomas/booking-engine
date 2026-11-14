import { describe, expect, test, vi } from "vitest";
import {
  buildCalendarPort,
  mapGoogleError,
  type CalendarApiLike,
} from "@/server/integrations/google/adapter";
import {
  AuthRevokedError,
  ProviderConflictError,
  ProviderGoneError,
  ProviderNotFoundError,
  ProviderValidationError,
  RateLimitedError,
  TransientProviderError,
} from "@/server/integrations/common/errors";

function fakeApi(overrides: Partial<CalendarApiLike["events"]> = {}) {
  const api = {
    events: {
      insert: vi.fn(async () => ({ data: { id: "evt" } })),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      list: vi.fn(async () => ({
        data: { items: [{ id: "a" }], nextPageToken: null, nextSyncToken: "tok" },
      })),
      watch: vi.fn(async () => ({
        data: { resourceId: "res", expiration: String(Date.parse("2026-11-21T00:00:00Z")) },
      })),
      ...overrides,
    },
    channels: { stop: vi.fn(async () => ({})) },
  };
  return api;
}

const input = {
  summary: "S",
  description: "D",
  location: "L",
  start: new Date("2026-11-20T01:00:00Z"),
  end: new Date("2026-11-20T02:00:00Z"),
  timeZone: "Australia/Melbourne",
  privateProps: { source: "booking-engine" },
};

describe("calendar port over googleapis", () => {
  test("insert sends our id, times, private props and suppresses notifications", async () => {
    const api = fakeApi();
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    expect(await port.insertEvent("cal", "id1", input)).toEqual({ id: "evt" });
    expect(api.events.insert).toHaveBeenCalledWith({
      calendarId: "cal",
      sendUpdates: "none",
      requestBody: {
        id: "id1",
        summary: "S",
        description: "D",
        location: "L",
        start: { dateTime: "2026-11-20T01:00:00.000Z", timeZone: "Australia/Melbourne" },
        end: { dateTime: "2026-11-20T02:00:00.000Z", timeZone: "Australia/Melbourne" },
        extendedProperties: { private: { source: "booking-engine" } },
      },
    });
  });

  test("patch sends only given fields plus status", async () => {
    const api = fakeApi();
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    await port.patchEvent("cal", "id1", { status: "confirmed", summary: "New" });
    expect(api.events.patch).toHaveBeenCalledWith({
      calendarId: "cal",
      eventId: "id1",
      sendUpdates: "none",
      requestBody: { summary: "New", status: "confirmed" },
    });
  });

  test("delete, stop channel", async () => {
    const api = fakeApi();
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    await port.deleteEvent("cal", "id1");
    await port.stopChannel("ch", "res");
    expect(api.events.delete).toHaveBeenCalledWith({
      calendarId: "cal",
      eventId: "id1",
      sendUpdates: "none",
    });
    expect(api.channels.stop).toHaveBeenCalledWith({
      requestBody: { id: "ch", resourceId: "res" },
    });
  });

  test("full list passes the window and expands recurring events; sync list passes only the token", async () => {
    const api = fakeApi();
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    const full = await port.listEvents("cal", {
      timeMin: new Date("2026-11-13T00:00:00Z"),
      timeMax: new Date("2027-05-01T00:00:00Z"),
      pageToken: "p",
    });
    expect(full).toEqual({ events: [{ id: "a" }], nextPageToken: undefined, nextSyncToken: "tok" });
    expect(api.events.list).toHaveBeenLastCalledWith({
      calendarId: "cal",
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
      pageToken: "p",
      timeMin: "2026-11-13T00:00:00.000Z",
      timeMax: "2027-05-01T00:00:00.000Z",
    });
    await port.listEvents("cal", { syncToken: "tok", timeMin: new Date() });
    const query = (api.events.list as unknown as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )![0] as Record<string, unknown>;
    expect(query.syncToken).toBe("tok");
    expect(query).not.toHaveProperty("timeMin");
  });

  test("a list with no items returns an empty array", async () => {
    const api = fakeApi({ list: vi.fn(async () => ({ data: {} })) });
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    expect(await port.listEvents("cal", {})).toEqual({
      events: [],
      nextPageToken: undefined,
      nextSyncToken: undefined,
    });
  });

  test("watch registers a web_hook channel and parses the expiry", async () => {
    const api = fakeApi();
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    const result = await port.watch("cal", {
      channelId: "ch",
      address: "https://x/hook",
      token: "tok",
      ttlSeconds: 604800,
    });
    expect(result).toEqual({ resourceId: "res", expiration: new Date("2026-11-21T00:00:00Z") });
    expect(api.events.watch).toHaveBeenCalledWith({
      calendarId: "cal",
      requestBody: {
        id: "ch",
        type: "web_hook",
        address: "https://x/hook",
        token: "tok",
        params: { ttl: "604800" },
      },
    });
  });

  test("watch with no resource id fails; a missing expiry falls back to the ttl", async () => {
    const bad = buildCalendarPort(
      fakeApi({ watch: vi.fn(async () => ({ data: {} })) }) as unknown as CalendarApiLike,
    );
    await expect(
      bad.watch("c", { channelId: "c", address: "a", token: "t", ttlSeconds: 1 }),
    ).rejects.toBeInstanceOf(TransientProviderError);
    const noExpiry = buildCalendarPort(
      fakeApi({
        watch: vi.fn(async () => ({ data: { resourceId: "r" } })),
      }) as unknown as CalendarApiLike,
    );
    const result = await noExpiry.watch("c", {
      channelId: "c",
      address: "a",
      token: "t",
      ttlSeconds: 60,
    });
    expect(result.expiration.getTime()).toBeGreaterThan(Date.now());
  });

  test("errors from the client are translated", async () => {
    const api = fakeApi({
      insert: vi.fn(async () => {
        throw { response: { status: 409 }, message: "dup" };
      }),
    });
    const port = buildCalendarPort(api as unknown as CalendarApiLike);
    await expect(port.insertEvent("c", "i", input)).rejects.toBeInstanceOf(ProviderConflictError);
  });
});

describe("mapGoogleError", () => {
  test.each([
    [{ response: { status: 404 } }, ProviderNotFoundError],
    [{ response: { status: 409 } }, ProviderConflictError],
    [{ response: { status: 410 } }, ProviderGoneError],
    [{ response: { status: 401 } }, AuthRevokedError],
    [{ response: { status: 403 } }, AuthRevokedError],
    [{ response: { status: 400 } }, ProviderValidationError],
    [{ response: { status: 503 } }, TransientProviderError],
    [{ code: 500 }, TransientProviderError],
    [{ message: "invalid_grant" }, AuthRevokedError],
    [{ response: { status: 400, data: { error: "invalid_grant" } } }, AuthRevokedError],
    [{ response: { status: 429, headers: { "retry-after": "12" } } }, RateLimitedError],
    [
      {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
        },
      },
      RateLimitedError,
    ],
    ["a string", TransientProviderError],
  ])("%j", (input, expected) => {
    expect(mapGoogleError(input)).toBeInstanceOf(expected);
  });

  test("429 honours Retry-After, defaulting to 30s", () => {
    const withHeader = mapGoogleError({
      response: { status: 429, headers: { "retry-after": "12" } },
    });
    expect((withHeader as RateLimitedError).retryAfterSec).toBe(12);
    const without = mapGoogleError({ response: { status: 429 } });
    expect((without as RateLimitedError).retryAfterSec).toBe(30);
  });
});
