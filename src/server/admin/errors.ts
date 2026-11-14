/** An error whose message is safe and useful to show to the owner as-is. */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** True for Postgres exclusion violations (double booking guard) raised by the no_overlap constraint. */
export function isOverlapError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "23P01") return true;
    if (typeof e.message === "string" && /no_overlap|conflicting key value/i.test(e.message)) {
      return true;
    }
    current = e.cause;
  }
  return false;
}
