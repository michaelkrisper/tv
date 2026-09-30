// GitHub Pages erlaubt keine eigenen Cache-Header (fix max-age=600), deshalb
// regelt der Service Worker das Caching selbst:
//   Hülle   vorab geladen, immer aus dem Cache; neue Version = neuer Worker
//   Bilder  Namen sind Hashes bzw. feste URLs der Resize-Dienste: Cache zuerst
//   Daten   sofort aus dem Cache, im Hintergrund neu; bei Änderung Bescheid geben

const VERSION = '__VERSION__';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const IMG = 'img';
const MAX_IMG = 800;
// Live-Bilder für "Jetzt"; beide Dienste senden CORS, also cachebar.
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
        Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))),
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

async function notify(url) {
  for (const c of await self.clients.matchAll()) c.postMessage(url.endsWith('list.json') ? 'list' : 'data');
}

// Tagesdateien von gestern und älter wegräumen.
async function purge(cache) {
  const d = new Date(Date.now() - 864e5);
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const k of await cache.keys()) {
    const m = /data\/(\d{4}-\d\d-\d\d)/.exec(k.url);
    if (m && m[1] < cutoff) cache.delete(k);
  }
}

async function data(req, e) {
  const cache = await caches.open(DATA);
  if (Math.random() < 0.05) e.waitUntil(purge(cache));
  const hit = await cache.match(req);
  const fresh = fetch(req, { cache: 'no-cache' }).then(async (res) => {
    if (res.ok) {
      const changed = hit && hit.headers.get('etag') !== res.headers.get('etag');
      await cache.put(req, res.clone());
      if (changed) await notify(req.url);
    }
    return res;
  });
  if (hit) {
    e.waitUntil(fresh.catch(() => {}));
    return hit;
  }
  return fresh;
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
  else if (path.startsWith('data/')) e.respondWith(data(req, e));
  else if (req.mode === 'navigate') e.respondWith(shell(new Request('./')).catch(() => fetch(req)));
  else e.respondWith(shell(req));
});
