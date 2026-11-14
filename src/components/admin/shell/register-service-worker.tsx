"use client";

import { useEffect } from "react";

/** Registers the minimal offline-shell service worker (production only, so dev HMR is never cached). */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // Not fatal: the admin works online without it.
    });
  }, []);
  return null;
}
