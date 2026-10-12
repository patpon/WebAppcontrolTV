/* Service worker for the TV player.
   - media/*   : cache-first (videos are fetched whole so they can be cached; Cache API cannot store 206 responses)
   - app shell : stale-while-revalidate
   - config    : not handled here (tv.js keeps its own last-good copy) */
const MEDIA_CACHE = 'rb-media-v1';
const SHELL_CACHE = 'rb-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data/config.json')) return;

  if (url.pathname.includes('/media/')) {
    event.respondWith(mediaFirst(url));
  } else if (/\.(html|css|js|svg|png|jpg|webp)$/.test(url.pathname) || url.pathname.endsWith('/')) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function mediaFirst(url) {
  const key = url.origin + url.pathname;
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(key);
  if (res.ok && res.status === 200) cache.put(key, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

/* tv.js posts the list of media still in use; drop everything else so the TV's storage doesn't fill up. */
self.addEventListener('message', async e => {
  if (!e.data || e.data.type !== 'keep-media') return;
  const keep = new Set(e.data.urls);
  const cache = await caches.open(MEDIA_CACHE);
  for (const req of await cache.keys()) {
    if (!keep.has(req.url)) await cache.delete(req);
  }
});
