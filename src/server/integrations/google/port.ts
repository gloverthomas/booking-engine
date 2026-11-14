/**
 * The narrow surface of Google Calendar this app needs. `adapter.ts` implements it with the
 * `googleapis` package; tests use fakes, so nothing here touches the network.
 *
 * Adapters throw the errors in ../common/errors: ProviderConflictError (409),
 * ProviderNotFoundError (404), ProviderGoneError (410, which for `listEvents` means the sync
 * token expired), RateLimitedError (429/quota), AuthRevokedError (invalid_grant / 401).
 */

/** Marks events we created so the inbound sync can ignore them. */
export const EVENT_SOURCE_KEY = "source";
export const EVENT_SOURCE_VALUE = "booking-engine";
export const EVENT_BOOKING_KEY = "bookingId";

export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  timeZone: string;
  /** Written to extendedProperties.private. */
  privateProps: Record<string, string>;
}

export interface CalendarEventPatch extends Partial<CalendarEventInput> {
  /** Patching a deleted event with `confirmed` brings it back. */
  status?: "confirmed" | "cancelled";
}

/** A Google event as returned by `events.list`, reduced to what the sync reads. */
export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  /** "opaque" (busy, the default) or "transparent" (free). */
  transparency?: string;
  eventType?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}

export interface ListEventsParams {
  syncToken?: string;
  pageToken?: string;
  /** Only honoured on a full sync (no syncToken). */
  timeMin?: Date;
  timeMax?: Date;
}

export interface ListEventsResult {
  events: GoogleCalendarEvent[];
  nextPageToken?: string;
  /** Present on the last page only. */
  nextSyncToken?: string;
}

export interface WatchRequest {
  channelId: string;
  /** HTTPS URL Google will POST notifications to. */
  address: string;
  /** Echoed back by Google in X-Goog-Channel-Token. */
  token: string;
  ttlSeconds: number;
}

export interface WatchResult {
  resourceId: string;
  expiration: Date;
}

export interface GoogleCalendarPort {
  insertEvent(
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
  ): Promise<{ id: string }>;
  patchEvent(calendarId: string, eventId: string, patch: CalendarEventPatch): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  listEvents(calendarId: string, params: ListEventsParams): Promise<ListEventsResult>;
  watch(calendarId: string, request: WatchRequest): Promise<WatchResult>;
  stopChannel(channelId: string, resourceId: string): Promise<void>;
}

export interface GoogleTokens {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiryDate?: number;
  scope?: string;
}

export interface GoogleAuthPort {
  buildAuthUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): Promise<string>;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GoogleTokens>;
}
