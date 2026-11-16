/**
 * Returning-client prefill, kept in the visitor's own browser (first-party localStorage). It never
 * stores consent: marketing opt-in and policy acceptance always start unticked.
 */

export interface RememberedClient {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export const REMEMBERED_KEY = "rk.client.v1";

const FIELDS: Array<keyof RememberedClient> = [
  "firstName",
  "lastName",
  "email",
  "phone",
];

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadRememberedClient(
  storage: StorageLike | null = defaultStorage(),
): RememberedClient | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(REMEMBERED_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const source = parsed as Record<string, unknown>;
    const out = Object.fromEntries(
      FIELDS.map((key) => [key, typeof source[key] === "string" ? (source[key] as string) : ""]),
    ) as unknown as RememberedClient;
    return out.firstName || out.email ? out : null;
  } catch {
    return null;
  }
}

export function saveRememberedClient(
  client: RememberedClient,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(REMEMBERED_KEY, JSON.stringify(client));
  } catch {
    // Storage can be full or blocked (private mode, embedded contexts); prefill is a nicety.
  }
}

export function forgetRememberedClient(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(REMEMBERED_KEY);
  } catch {
    // Nothing to do.
  }
}
