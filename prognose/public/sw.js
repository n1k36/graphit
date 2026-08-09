/**
 * Service worker: makes the app installable and survivable offline.
 *
 * Strategy is deliberately conservative for a trading app —
 *   /api/*  → network only. A cached price is a wrong price.
 *   shell   → network first, falling back to cache when the network is gone.
 *   icons   → cache first, they never change within a version.
 *
 * Bump CACHE_VERSION on release to evict the old shell.
 */

const CACHE_VERSION = 'prophit-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve stale prices, balances or positions.
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A cold deep link while offline still gets the app shell.
        return (await caches.match('/index.html')) ?? Response.error();
      }),
  );
});
