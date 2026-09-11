/**
 * sw.js — service worker.
 *
 * SplitUPI has no backend, so "offline" is the normal case rather than a
 * fallback. Strategy:
 *   - navigations: network-first with a cached shell fallback, so a deployed
 *     update is picked up promptly but a flaky train tunnel still opens the app
 *   - same-origin assets: stale-while-revalidate, so the app starts instantly
 *     and quietly refreshes itself in the background
 *   - anything cross-origin: passed straight through, never cached
 *
 * Bump CACHE_VERSION on every release; old caches are deleted on activate.
 */

const CACHE_VERSION = 'splitupi-v1';
const SHELL = 'index.html';

/** Everything needed to boot the app with no network at all. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/styles.css',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './src/ui/app.js',
  './src/ui/components.js',
  './src/ui/dashboard.js',
  './src/ui/group.js',
  './src/ui/expenses.js',
  './src/ui/expense-form.js',
  './src/ui/balances.js',
  './src/ui/settle.js',
  './src/ui/members.js',
  './src/ui/insights.js',
  './src/ui/settings.js',
  './src/core/money.js',
  './src/core/split.js',
  './src/core/balances.js',
  './src/core/settle.js',
  './src/core/upi.js',
  './src/core/qr.js',
  './src/core/store.js',
  './src/core/share.js',
  './src/core/csv.js',
  './src/core/id.js',
  './src/core/recurring.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // addAll() is all-or-nothing; cache entries individually so one missing
      // optional file (an icon, say) cannot block the whole install.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

/** Network first, falling back to the cached shell when offline. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(SHELL, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(SHELL)) || (await cache.match('./')) || Response.error();
  }
}

/** Serve from cache immediately, refresh in the background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  return cached || (await network) || Response.error();
}

/** Let the page trigger an immediate update. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
