// Kept free of imports so the Clock widget (shown on every admin page) does not bundle a date library.

/** "3h 10m", "45m", "2h", "-1h 30m". */
export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

/** Like formatDuration but with an explicit plus sign for gains, so a difference never relies on colour. */
export function formatSignedDuration(minutes: number): string {
  return minutes > 0 ? `+${formatDuration(minutes)}` : formatDuration(minutes);
}
