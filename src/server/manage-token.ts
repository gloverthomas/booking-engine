import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless "manage my booking" token: `<bookingId>.<hmac>`. Nothing is stored, so any module
 * (confirmation email, reminder SMS, the public page) can rebuild the same link from a booking id.
 * The key is ENCRYPTION_KEY (base64). Rotating the key invalidates old links.
 */
export function makeManageToken(bookingId: string, key: string): string {
  const mac = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`manage:${bookingId}`)
    .digest("base64url");
  return `${bookingId}.${mac}`;
}

/** Returns the booking id when the token is authentic, otherwise null. */
export function verifyManageToken(token: string, key: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const bookingId = token.slice(0, dot);
  const expected = Buffer.from(makeManageToken(bookingId, key));
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? bookingId : null;
}
