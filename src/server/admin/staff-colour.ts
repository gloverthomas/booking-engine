/**
 * Calendar colour per stylist. `staff.colour` wins when it is a valid hex; otherwise a stable palette
 * colour by the person's position in creation order, so adding someone never recolours the others.
 * Pure (no server imports) because the calendar UI uses it too.
 */
export const STAFF_PALETTE: readonly string[] = [
  "#0f5c5c",
  "#7a3b69",
  "#8a4b12",
  "#2f4b8c",
  "#5b6b1f",
  "#8c2f3d",
  "#3f6b8c",
  "#6b4f1d",
  "#5c3d8f",
  "#2e6b3e",
];

/** Used for events whose stylist is no longer on the team. */
export const UNKNOWN_STAFF_COLOUR = "#57534e";

const HEX = /^#[0-9a-f]{6}$/i;

export function resolveStaffColour(colour: string | null | undefined, index: number): string {
  if (colour && HEX.test(colour.trim())) return colour.trim().toLowerCase();
  const safe = Number.isInteger(index) && index >= 0 ? index : 0;
  return STAFF_PALETTE[safe % STAFF_PALETTE.length];
}

/** Colour for every person, by their position in the given (creation) order. */
export function assignStaffColours(
  rows: ReadonlyArray<{ id: string; colour: string | null }>,
): Map<string, string> {
  return new Map(rows.map((row, index) => [row.id, resolveStaffColour(row.colour, index)]));
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Black or white text, whichever reads better on the given hex background. */
export function readableTextColour(background: string): string {
  if (!HEX.test(background)) return "#ffffff";
  const r = channel(Number.parseInt(background.slice(1, 3), 16));
  const g = channel(Number.parseInt(background.slice(3, 5), 16));
  const b = channel(Number.parseInt(background.slice(5, 7), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? "#1c1917" : "#ffffff";
}
