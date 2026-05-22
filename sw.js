// iPrint ERP Service Worker v2
// Network-first for HTML (always fresh after deploys), cache-first for static assets.
// Bump CACHE_NAME to force-evict on the next visit when sw.js itself changes.

const CACHE_NAME = 'iprint-erp-v2';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png'
];

// Install: precache static assets, activate new SW immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Activate: drop old caches, take control of all open clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: routing strategy depends on request type
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET; let everything else hit the network normally
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip cross-origin (Supabase, Resend, fonts.googleapis, etc.) — let them hit network directly
  if (url.origin !== self.location.origin) return;

  const isHTML =
    req.mode === 'navigate' ||
    req.destination === 'document' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html');

  if (isHTML) {
    // Network-first for the app shell — always pull latest deploy
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // Update cache in background for offline fallback
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static assets — cache-first, fall back to network and cache the result
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});

// Optional: let the page tell the SW to skip waiting (useful if you ever want a manual "update now" button)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
