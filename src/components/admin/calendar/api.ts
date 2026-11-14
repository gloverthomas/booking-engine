import type { ActionResult } from "@/server/admin/errors";

/** GET JSON from one of the admin read endpoints. Throws an Error with a human message on failure. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 401) {
    throw new Error("You have been signed out. Reload the page to sign in again.");
  }
  if (!response.ok) {
    let message = "Could not load that. Please try again.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** Server actions can reject (network drop, deploy mid-flight). Turn that into the same failure shape. */
export async function callAction<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch {
    return {
      ok: false,
      error: "The server did not respond properly. Check your connection and try again.",
    };
  }
}
