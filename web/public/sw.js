// Minimal service worker so the dashboard is installable. Network-only: picks and scores
// must never be served stale, so nothing is cached here.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
