/**
 * postMessage protocol for the iframe embed. The host page listens for messages whose
 * `source` is "rk-booking" and sizes/scrolls its iframe accordingly (see README.md).
 */

export const EMBED_SOURCE = "rk-booking";

export type EmbedMessage =
  | { source: typeof EMBED_SOURCE; type: "resize"; height: number }
  | { source: typeof EMBED_SOURCE; type: "scroll-top" };

interface MessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export function isEmbedded(win: { self: unknown; top: unknown }): boolean {
  try {
    return win.self !== win.top;
  } catch {
    // Cross-origin access to `top` throws; that only happens when we are framed.
    return true;
  }
}

/**
 * The height carries no sensitive data, so `*` is acceptable: the host cannot be known at build
 * time and frame-ancestors already restricts who may embed us.
 */
export function postEmbedMessage(parent: MessageTarget, message: EmbedMessage): void {
  parent.postMessage(message, "*");
}

export function resizeMessage(height: number): EmbedMessage {
  return { source: EMBED_SOURCE, type: "resize", height: Math.ceil(height) };
}
