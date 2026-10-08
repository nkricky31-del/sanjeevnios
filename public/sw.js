/* SanjeevniOS service worker.
 *
 * What it does: lets the installed app open instantly and show its shell when
 * the network is down or slow (the screens then say what needs a connection).
 *
 * What it deliberately does NOT do: it only ever touches this site's own static
 * files (GET, same origin). Every call to Supabase, Razorpay, maps, fonts and
 * any other site passes straight through, so no patient data, session token or
 * payment response is ever stored by it.
 *
 *   navigations         network first (4 s), fall back to the cached app shell
 *   /assets/*           cache first (file names are content-hashed, so immutable)
 *   icons, images, etc  stale-while-revalidate
 */
// Replaced with a fresh stamp on every production build (see vite.config.ts), so
// each deploy changes this file, the browser installs it, and old caches are purged.
const VERSION = '__BUILD_ID__';
const SHELL = `sos-shell-${VERSION}`;
const RUNTIME = `sos-runtime-${VERSION}`;
const STATIC = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png'];
const MAX_RUNTIME_ENTRIES = 80;
const NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Read the shell to learn which hashed bundles it needs, so the very first
      // offline visit already has them (not only the second).
      let assets = [];
      try {
        const html = await (await fetch('/', { cache: 'reload' })).text();
        assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      } catch {
        /* offline during install: the runtime caches fill in on first use */
      }
      await Promise.allSettled([...STATIC, ...assets].map((u) => cache.add(u)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, RUNTIME]);
      for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })()
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_RUNTIME_ENTRIES) {
    await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map((k) => cache.delete(k)));
  }
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)),
    ]);
    // Every route is served the same index.html, so keep one copy under "/".
    if (fresh && fresh.ok) cache.put('/', fresh.clone());
    return fresh;
  } catch {
    return (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) {
    const cache = await caches.open(RUNTIME);
    cache.put(request, res.clone());
    trim(cache);
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res && res.ok) {
        cache.put(request, res.clone());
        trim(cache);
      }
      return res;
    })
    .catch(() => undefined);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, Razorpay, maps, fonts: untouched
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
