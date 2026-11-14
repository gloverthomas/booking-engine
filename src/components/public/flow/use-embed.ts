"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { isEmbedded, postEmbedMessage, resizeMessage } from "./embed";

const noopSubscribe = () => () => {};

/** True when the page is running inside an iframe. Server and first client render say false. */
export function useEmbedded(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => isEmbedded(window),
    () => false,
  );
}

/** Report the page height to the host page whenever it changes (iframe embeds only). */
export function useEmbedResize(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const report = () =>
      postEmbedMessage(window.parent, resizeMessage(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
}

/** Bring the top of the flow into view: scroll ourselves, or ask the host page to scroll the iframe. */
export function scrollFlowToTop(el: HTMLElement | null, embedded: boolean): void {
  if (embedded) {
    postEmbedMessage(window.parent, { source: "rk-booking", type: "scroll-top" });
    return;
  }
  el?.scrollIntoView({ block: "start", behavior: "auto" });
}
