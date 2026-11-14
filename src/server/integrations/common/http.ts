import {
  OAUTH_TTL_MS,
  oauthCookieName,
  oauthCookiePath,
  serializeCookie,
  type OAuthProvider,
} from "./oauth-state";

/** Where the owner lands after connecting. D owns the settings screens; query params carry the result. */
export const SETTINGS_PATH = "/settings";

export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function setOAuthCookie(provider: OAuthProvider, value: string, secure: boolean): string {
  return serializeCookie(oauthCookieName(provider), value, {
    maxAgeSec: Math.floor(OAUTH_TTL_MS / 1000),
    path: oauthCookiePath(provider),
    secure,
  });
}

export function clearOAuthCookie(provider: OAuthProvider, secure: boolean): string {
  return serializeCookie(oauthCookieName(provider), "", {
    maxAgeSec: 0,
    path: oauthCookiePath(provider),
    secure,
  });
}

/** Back to the admin with the outcome in the query string (never anything secret). */
export function settingsRedirect(
  appUrl: string,
  provider: OAuthProvider,
  result: { ok: true } | { ok: false; message: string },
  cookies: string[],
): Response {
  const params = new URLSearchParams({
    integration: provider,
    status: result.ok ? "connected" : "error",
  });
  if (!result.ok) params.set("message", result.message);
  return redirectResponse(`${appUrl}${SETTINGS_PATH}?${params.toString()}`, cookies);
}
