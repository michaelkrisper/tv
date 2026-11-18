// The service worker handles caching itself, independent of the cache headers
// of the host:
//   shell   precached, always from cache; new version = new worker
//   images  names are hashes or stable resize-service URLs: cache first
//   api     served from cache immediately, refreshed in the background; notify on change;
//           offline the last answer is used even for another channel selection

const VERSION = '__VERSION__';
// Apps on one origin share one cache storage, so the shell cache carries the
// app's prefix and cleanup only touches tv-shell- caches.
const SHELL = `tv-shell-${VERSION}`;
const DATA = 'data';
const IMG = 'img';
const MAX_IMG = 800;
// Live images for "Jetzt"; both services send CORS headers, so they are cacheable.
const IMG_HOSTS = ['wsrv.nl', 'files.fairu.app'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('tv-shell-') && k !== SHELL).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMG)).map((k) => cache.delete(k)));
}

async function image(req) {
  const cache = await caches.open(IMG);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (Math.random() < 0.05) trim(cache);
  }
  return res;
}

async function notify(what) {
  for (const c of await self.clients.matchAll()) c.postMessage(what);
}

// Remove days from yesterday and older, and the static files older apps read.
async function purge(cache) {
  const d = new Date(Date.now() - 864e5);
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const k of await cache.keys()) {
    const m = /date=(\d{4}-\d\d-\d\d)/.exec(k.url);
    if ((m && m[1] < cutoff) || new URL(k.url).pathname.includes('/data/')) cache.delete(k);
  }
}

const samePath = (keys, path) => keys.filter((k) => new URL(k.url).pathname === path);

// API answers. start and details differ per channel selection, so only the
// latest answer of each is kept; offline it is used whatever the selection is.
// The list (start) and single days come from the cache at once and refresh in
// the background; the details are fetched while idle, so fresh ones win there.
async function api(req, e) {
  const cache = await caches.open(DATA);
  if (Math.random() < 0.05) e.waitUntil(purge(cache));
  const path = new URL(req.url).pathname;
  const single = !path.endsWith('/day');
  const hit = await cache.match(req);
  const fresh = fetch(req).then(async (res) => {
    if (res.ok) {
      const changed = hit && hit.headers.get('etag') !== res.headers.get('etag');
      if (single) {
        const old = samePath(await cache.keys(), path).filter((k) => k.url !== req.url);
        await Promise.all(old.map((k) => cache.delete(k)));
      }
      await cache.put(req, res.clone());
      if (changed && path.endsWith('/start')) await notify('list');
    }
    return res;
  });
  if (hit && !path.endsWith('/details')) {
    e.waitUntil(fresh.catch(() => {}));
    return hit;
  }
  return fresh.catch(async (err) => {
    const last = hit ?? (single && (await cache.match(samePath(await cache.keys(), path)[0] ?? req)));
    if (last) return last;
    throw err;
  });
}

async function shell(req) {
  const hit = await caches.match(req, { cacheName: SHELL, ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && req.mode !== 'navigate') (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (IMG_HOSTS.includes(url.hostname)) return e.respondWith(image(req));
  if (url.origin !== location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (path.startsWith('img/')) e.respondWith(image(req));
  else if (path.startsWith('api/')) e.respondWith(api(req, e));
  else if (req.mode === 'navigate') e.respondWith(shell(new Request('./')).catch(() => fetch(req)));
  else e.respondWith(shell(req));
});
