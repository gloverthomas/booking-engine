/** Local minutes since midnight as a compact clock time: 540 -> "9am", 570 -> "9:30am", 1020 -> "5pm". */
export function formatMinute(minute: number): string {
  if (minute >= 1440) return "12am";
  const hour24 = Math.floor(minute / 60);
  const mins = minute % 60;
  const suffix = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return mins === 0 ? `${hour12}${suffix}` : `${hour12}:${String(mins).padStart(2, "0")}${suffix}`;
}

export function formatMinuteRange(range: { startMinute: number; endMinute: number }): string {
  return `${formatMinute(range.startMinute)} to ${formatMinute(range.endMinute)}`;
}

/** "Mon 2 Nov" for a local YYYY-MM-DD date. */
export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: "UTC" }).format(
    utc,
  );
  const monthName = new Intl.DateTimeFormat("en-AU", { month: "short", timeZone: "UTC" }).format(
    utc,
  );
  return `${weekday} ${day} ${monthName}`;
}
