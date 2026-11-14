/*
 * Minimal service worker for the admin PWA: it only provides an offline shell.
 *
 * It deliberately caches NOTHING from the app itself (no pages, no API or auth responses, no data),
 * because the admin shows private client and booking data and must never serve a stale or shared copy.
 * The one cached asset is /offline.html, shown when a page navigation fails because there is no network.
 */
const CACHE = "rk-admin-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Only top-level page loads. Everything else (API, auth, assets, server actions) goes straight to the network.
  if (request.mode !== "navigate") return;
  event.respondWith(
    fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match(OFFLINE_URL))),
  );
});
