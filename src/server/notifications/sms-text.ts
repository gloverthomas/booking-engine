/**
 * SMS text helpers: E.164 validation, ASCII-safe sanitising and GSM-7 segment counting.
 * Plain ASCII keeps a message in the cheap 160-character GSM encoding; one curly quote or emoji
 * would force UCS-2 (70 characters per segment) and roughly double the cost.
 */

const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(phone: string): boolean {
  return E164.test(phone);
}

const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, "-"],
  [/…/g, "..."],
  [/[    ]/g, " "],
  [/•/g, "*"],
];

/** Make text ASCII-only: smart punctuation becomes plain, accents are stripped, the rest is dropped. */
export function toAsciiSafe(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return out
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** GSM-7 extension characters cost two septets each. */
const GSM_EXTENDED = new Set(["^", "{", "}", "\\", "[", "]", "~", "|"]);

export interface SmsSize {
  /** GSM septets used (extension characters count twice). */
  length: number;
  segments: number;
}

export const SMS_SINGLE_SEGMENT = 160;
export const SMS_MULTI_SEGMENT = 153;

/** Assumes input already passed through `toAsciiSafe`. */
export function measureSms(body: string): SmsSize {
  let length = 0;
  for (const ch of body) length += GSM_EXTENDED.has(ch) ? 2 : 1;
  const segments =
    length === 0 ? 0 : length <= SMS_SINGLE_SEGMENT ? 1 : Math.ceil(length / SMS_MULTI_SEGMENT);
  return { length, segments };
}
