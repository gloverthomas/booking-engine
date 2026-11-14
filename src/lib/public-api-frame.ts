/**
 * Response headers that let the public booking pages be embedded in an iframe on the business's
 * own website, and nowhere else.
 *
 * Configure with `PUBLIC_EMBED_ORIGINS`: a comma-separated list of origins allowed to frame the
 * booking pages, e.g. `https://www.ryankennedyhair.com.au,https://ryankennedyhair.com.au`.
 * Unset means the pages may only be framed by their own origin.
 *
 * Wire into next.config.ts (integrator):
 *
 *   import { publicFrameHeaders } from "./src/lib/public-api-frame";
 *   async headers() { return publicFrameHeaders(process.env.PUBLIC_EMBED_ORIGINS); }
 *
 * `frame-ancestors` supersedes X-Frame-Options in every current browser, so none is sent here.
 * Admin routes are not matched and should keep their own `frame-ancestors 'none'`.
 */

export interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/** Valid, de-duplicated origins from a comma-separated env value. Invalid entries are dropped. */
export function parseEmbedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = raw
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter((o) => ORIGIN_RE.test(o));
  return [...new Set(origins)];
}

export function frameAncestorsValue(raw: string | undefined): string {
  const origins = parseEmbedOrigins(raw);
  return `frame-ancestors 'self'${origins.length > 0 ? ` ${origins.join(" ")}` : ""}`;
}

export function publicFrameHeaders(raw: string | undefined): HeaderRule[] {
  const headers = [{ key: "Content-Security-Policy", value: frameAncestorsValue(raw) }];
  return [
    { source: "/book", headers },
    { source: "/book/:path*", headers },
    { source: "/manage/:path*", headers },
  ];
}
