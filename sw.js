// iPrint ERP service worker — network-first.
// Goal: enable install + offline launch shell. Never serve stale app shell.
// Bump CACHE_VERSION on every deploy that ships a new SW.

const CACHE_VERSION = 'iprint-erp-v1';
const SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/apple-touch-icon.png'
];

// Install: pre-cache the app shell. skipWaiting so updates activate on next load.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: drop old caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for navigation + same-origin GETs.
// Supabase / fonts / CDN scripts: bypass entirely (let browser do its thing).
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET. Skip API calls, CDNs, Supabase, third-party scripts.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // For navigation requests (HTML), network-first; fall back to cached shell '/'.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Update shell cache opportunistically
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error()))
    );
    return;
  }

  // For other same-origin GETs (icons, manifest): network-first with cache fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
