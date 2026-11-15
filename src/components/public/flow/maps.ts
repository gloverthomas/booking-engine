/** Helpers for the map on the location step. Pure, so they are easy to test. */

export interface MapLocation {
  name: string;
  addressLine: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}

/** "302 Rathdowne Street, Carlton North VIC 3054, Australia", or null when there is no street address. */
export function mapQuery(location: MapLocation): string | null {
  if (!location.addressLine) return null;
  const locality = [location.suburb, location.state, location.postcode].filter(Boolean).join(" ");
  return [location.addressLine, locality, "Australia"].filter(Boolean).join(", ");
}

/** Opens Google Maps (app or web) at the address. Needs no API key. */
export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Turn-by-turn directions to the address from wherever the client is. Needs no API key. */
export function mapsDirectionsUrl(query: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

/**
 * Google Maps Embed API (free, needs a browser key restricted to this site's domains).
 * Null when no key is configured, so the page falls back to plain links rather than an unofficial embed.
 */
export function mapsEmbedUrl(query: string, key: string | undefined): string | null {
  if (!key?.trim()) return null;
  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key.trim())}&q=${encodeURIComponent(query)}`;
}
