import {
  AuthRevokedError,
  ProviderConflictError,
  ProviderGoneError,
  ProviderNotFoundError,
  ProviderValidationError,
  RateLimitedError,
  TransientProviderError,
} from "../common/errors";
import type {
  CalendarEventInput,
  CalendarEventPatch,
  GoogleAuthPort,
  GoogleCalendarEvent,
  GoogleCalendarPort,
  GoogleTokens,
} from "./port";

/** The slice of googleapis' calendar_v3 client the adapter uses. Real clients are cast to this. */
export interface CalendarApiLike {
  events: {
    insert(params: Record<string, unknown>): Promise<{ data: { id?: string | null } }>;
    patch(params: Record<string, unknown>): Promise<unknown>;
    delete(params: Record<string, unknown>): Promise<unknown>;
    list(params: Record<string, unknown>): Promise<{
      data: {
        items?: GoogleCalendarEvent[];
        nextPageToken?: string | null;
        nextSyncToken?: string | null;
      };
    }>;
    watch(params: Record<string, unknown>): Promise<{
      data: { resourceId?: string | null; expiration?: string | null };
    }>;
  };
  channels: { stop(params: Record<string, unknown>): Promise<unknown> };
}

interface GaxiosLikeError {
  code?: number | string;
  message?: string;
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, string | undefined>;
    data?: { error?: string | { errors?: Array<{ reason?: string }>; message?: string } };
  };
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

/** Translate a googleapis/gaxios failure into the neutral error taxonomy. */
export function mapGoogleError(error: unknown): Error {
  if (typeof error !== "object" || error === null) {
    return new TransientProviderError(String(error));
  }
  const e = error as GaxiosLikeError;
  const status = Number(e.response?.status ?? e.status ?? e.code);
  const message = e.message ?? "Google API error";
  const data = e.response?.data;
  const reason = typeof data?.error === "object" ? data.error?.errors?.[0]?.reason : undefined;

  if (message.includes("invalid_grant") || data?.error === "invalid_grant") {
    return new AuthRevokedError("Google access was revoked or has expired", { cause: error });
  }
  if (status === 401) return new AuthRevokedError(message, { cause: error });
  if (status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    const retryAfter = Number(e.response?.headers?.["retry-after"]);
    return new RateLimitedError(message, Number.isFinite(retryAfter) ? retryAfter : 30, {
      cause: error,
    });
  }
  if (status === 403) return new AuthRevokedError(message, { cause: error });
  if (status === 404) return new ProviderNotFoundError(message, { cause: error });
  if (status === 409) return new ProviderConflictError(message, { cause: error });
  if (status === 410) return new ProviderGoneError(message, { cause: error });
  if (status >= 400 && status < 500) return new ProviderValidationError(message, { cause: error });
  return new TransientProviderError(message, { cause: error });
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapGoogleError(error);
  }
}

function eventBody(event: Partial<CalendarEventInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (event.summary !== undefined) body.summary = event.summary;
  if (event.description !== undefined) body.description = event.description;
  if (event.location !== undefined) body.location = event.location;
  if (event.start) body.start = { dateTime: event.start.toISOString(), timeZone: event.timeZone };
  if (event.end) body.end = { dateTime: event.end.toISOString(), timeZone: event.timeZone };
  if (event.privateProps) body.extendedProperties = { private: event.privateProps };
  return body;
}

/** Calendar operations over an authorised calendar_v3 client. */
export function buildCalendarPort(api: CalendarApiLike): GoogleCalendarPort {
  return {
    async insertEvent(calendarId, eventId, event) {
      const response = await call(() =>
        api.events.insert({
          calendarId,
          sendUpdates: "none",
          requestBody: { id: eventId, ...eventBody(event) },
        }),
      );
      return { id: response.data.id ?? eventId };
    },

    async patchEvent(calendarId, eventId, patch: CalendarEventPatch) {
      const body = eventBody(patch);
      if (patch.status) body.status = patch.status;
      await call(() =>
        api.events.patch({ calendarId, eventId, sendUpdates: "none", requestBody: body }),
      );
    },

    async deleteEvent(calendarId, eventId) {
      await call(() => api.events.delete({ calendarId, eventId, sendUpdates: "none" }));
    },

    async listEvents(calendarId, params) {
      const query: Record<string, unknown> = {
        calendarId,
        singleEvents: true,
        showDeleted: true,
        maxResults: 250,
      };
      if (params.pageToken) query.pageToken = params.pageToken;
      if (params.syncToken) {
        query.syncToken = params.syncToken;
      } else {
        if (params.timeMin) query.timeMin = params.timeMin.toISOString();
        if (params.timeMax) query.timeMax = params.timeMax.toISOString();
      }
      const { data } = await call(() => api.events.list(query));
      return {
        events: data.items ?? [],
        nextPageToken: data.nextPageToken ?? undefined,
        nextSyncToken: data.nextSyncToken ?? undefined,
      };
    },

    async watch(calendarId, request) {
      const { data } = await call(() =>
        api.events.watch({
          calendarId,
          requestBody: {
            id: request.channelId,
            type: "web_hook",
            address: request.address,
            token: request.token,
            params: { ttl: String(request.ttlSeconds) },
          },
        }),
      );
      if (!data.resourceId) throw new TransientProviderError("Google watch returned no resourceId");
      const expiresMs = Number(data.expiration);
      return {
        resourceId: data.resourceId,
        expiration: new Date(
          Number.isFinite(expiresMs) ? expiresMs : Date.now() + request.ttlSeconds * 1000,
        ),
      };
    },

    async stopChannel(channelId, resourceId) {
      await call(() => api.channels.stop({ requestBody: { id: channelId, resourceId } }));
    },
  };
}

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface CreatePortInput extends GoogleClientConfig {
  tokens: GoogleTokens;
  /** Called when googleapis refreshes the access token, so it can be persisted. */
  onTokens: (tokens: GoogleTokens) => Promise<void> | void;
}

/** Real Google client. `googleapis` is imported lazily: it is large and tests never need it. */
export async function createGoogleCalendarPort(
  input: CreatePortInput,
): Promise<GoogleCalendarPort> {
  const { google } = await import("googleapis");
  const oauth = new google.auth.OAuth2(input.clientId, input.clientSecret);
  oauth.setCredentials({
    access_token: input.tokens.accessToken,
    refresh_token: input.tokens.refreshToken,
    expiry_date: input.tokens.expiryDate,
  });
  oauth.on("tokens", (fresh) => {
    void input.onTokens({
      accessToken: fresh.access_token ?? undefined,
      refreshToken: fresh.refresh_token ?? undefined,
      expiryDate: fresh.expiry_date ?? undefined,
    });
  });
  const api = google.calendar({ version: "v3", auth: oauth });
  return buildCalendarPort(api as unknown as CalendarApiLike);
}

/**
 * Narrowest scope that covers events.insert/patch/delete/list/watch.
 *
 * SETUP: in Google Cloud Console (APIs & Services > OAuth consent screen) set the publishing
 * status to "In production". An app left in "Testing" gets refresh tokens that expire after
 * 7 days, which silently disconnects the calendar every week. Because this is a single-user app,
 * the "unverified app" warning on the consent screen is fine: click Advanced > Continue, once.
 * After switching to production, disconnect and reconnect Google so a long-lived token is issued.
 * Also enable the "Google Calendar API" for the project.
 */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

export function createGoogleAuthPort(config: GoogleClientConfig): GoogleAuthPort {
  const make = async (redirectUri: string) => {
    const { google } = await import("googleapis");
    return new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
  };
  return {
    async buildAuthUrl({ state, codeChallenge, redirectUri }) {
      const oauth = await make(redirectUri);
      return oauth.generateAuthUrl({
        access_type: "offline",
        // Forces a refresh token even when the owner has connected before.
        prompt: "consent",
        scope: GOOGLE_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256" as never,
      });
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const oauth = await make(redirectUri);
      try {
        const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
        return {
          accessToken: tokens.access_token ?? undefined,
          refreshToken: tokens.refresh_token ?? undefined,
          expiryDate: tokens.expiry_date ?? undefined,
          scope: tokens.scope ?? undefined,
        };
      } catch (error) {
        throw mapGoogleError(error);
      }
    },
  };
}
