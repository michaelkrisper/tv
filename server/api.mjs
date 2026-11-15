// Read-only programme API: answers with exactly what the selected channels
// need, in one request, from the SQLite file the build writes (scripts/db.mjs).
//
//   GET /api/start?ch=a,b,c     channel list, 20:15 items and today's schedule
//                               from the current hour on: all the lists need
//   GET /api/details?ch=a,b,c   texts for the 20:15 items, their "Danach" and
//                               the next hours of today (idle prefetch)
//   GET /api/day?ch=a&date=D    one channel, one whole day with texts (on tap)
//
// Public and unauthenticated: no cookies, no user data, nothing is logged.
// Every answer depends only on the build, the hour and the query, so it gets
// an ETag without running a query and can be cached anywhere.
// One file without dependencies: the server runs a copy of it.

import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Same number as FORMAT in scripts/db.mjs.
const FORMAT = 1;
export const MAX_CHANNELS = 100;
const MAX_URL = 4096;
const ID = /^[a-z0-9+]{1,40}$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
const HOUR = 3600_000;
// Texts for programmes that start within this many hours; later ones load on tap.
const DETAIL_HOURS = 3;
const NEXT = 3;

// "a,b,c" -> sorted unique ids, or null if anything about it is off.
export function parseIds(value, max = MAX_CHANNELS) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  const ids = value.split(',');
  if (ids.length > max || !ids.every((id) => ID.test(id))) return null;
  return [...new Set(ids)].sort();
}

// Exactly the expected parameters, each once.
export function parseQuery(params, names) {
  const keys = [...params.keys()];
  if (keys.length !== names.length || !names.every((n) => params.getAll(n).length === 1)) return null;
  return Object.fromEntries(names.map((n) => [n, params.get(n)]));
}

// Values are JSON text already; only the keys need quoting.
const obj = (entries) => `{${entries.map(([k, v]) => `${JSON.stringify(String(k))}:${v}`).join(',')}}`;
const arr = (items) => `[${items.join(',')}]`;

function group(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
}

export function openStore(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const meta = Object.fromEntries(
    db
      .prepare('SELECT k, v FROM meta')
      .all()
      .map((r) => [r.k, r.v]),
  );
  if (Number(meta.format) !== FORMAT) {
    db.close();
    throw new Error(`database format ${meta.format}, expected ${FORMAT}`);
  }
  const built = Number(meta.built);
  const days = JSON.parse(meta.days);
  const dates = days.map((d) => d.date);
  const list = db.prepare('SELECT id, name, logo FROM channel ORDER BY pos').all();
  const known = new Set(list.map((c) => c.id));
  const channels = JSON.stringify(list.map((c) => [c.id, c.name, c.logo]));
  const IN = 'ch IN (SELECT value FROM json_each(?))';
  const q = {
    items: db.prepare(`SELECT date, ch, stop, row, detail FROM item WHERE ${IN} ORDER BY date, ch`),
    from: db.prepare(`SELECT ch, row FROM sched WHERE date = ? AND ${IN} AND stop > ? ORDER BY ch, start`),
    texts: db.prepare(
      `SELECT ch, start, detail FROM sched WHERE date = ? AND ${IN} AND stop > ? AND start < ? ORDER BY ch, start`,
    ),
    next: db.prepare(
      `SELECT row FROM sched WHERE date = ? AND ch = ? AND start >= ? ORDER BY start LIMIT ${NEXT}`,
    ),
    day: db.prepare('SELECT row, detail FROM sched WHERE date = ? AND ch = ? ORDER BY start'),
  };

  // The day "Jetzt" reads: the latest one that has begun. Its schedule runs
  // until 06:00 the next morning, so it also covers the time after midnight
  // until the next build. min = the current full hour in minutes of that day.
  function today(now) {
    const day = days.findLast((d) => d.from <= now);
    return day ? { date: day.date, min: Math.floor((now - day.from) / HOUR) * 60 } : null;
  }
  const pick = (ids) => JSON.stringify(ids.filter((id) => known.has(id)));
  const perDay = (rows, value) =>
    obj(dates.map((d) => [d, obj((rows.get(d) ?? []).map((r) => [r.ch, value(r)]).filter(([, v]) => v))]));

  return {
    built,
    close: () => db.close(),

    start(ids, now) {
      const mine = pick(ids);
      const t = today(now);
      const sched = t ? group(q.from.all(t.date, mine, t.min), 'ch') : new Map();
      return obj([
        ['built', built],
        ['days', JSON.stringify(dates)],
        ['channels', channels],
        ['items', perDay(group(q.items.all(mine), 'date'), (r) => r.row)],
        ['sdate', JSON.stringify(t?.date ?? null)],
        ['sched', obj([...sched].map(([ch, rows]) => [ch, arr(rows.map((r) => r.row))]))],
      ]);
    },

    details(ids, now) {
      const mine = pick(ids);
      const t = today(now);
      const items = group(q.items.all(mine), 'date');
      const texts = t ? group(q.texts.all(t.date, mine, t.min, t.min + DETAIL_HOURS * 60), 'ch') : new Map();
      const next = (r) => {
        const rows = q.next.all(r.date, r.ch, r.stop);
        return rows.length ? arr(rows.map((n) => n.row)) : '';
      };
      return obj([
        ['built', built],
        ['d', perDay(items, (r) => r.detail)],
        ['n', perDay(items, next)],
        ['sdate', JSON.stringify(t?.date ?? null)],
        ['x', obj([...texts].map(([ch, rows]) => [ch, obj(rows.map((r) => [r.start, r.detail]))]))],
      ]);
    },

    // null: unknown channel or a day that is not in the database
    day(id, date) {
      if (!known.has(id) || !dates.includes(date)) return null;
      const rows = q.day.all(date, id);
      return obj([
        ['rows', arr(rows.map((r) => r.row))],
        ['x', arr(rows.map((r) => r.detail))],
      ]);
    },
  };
}

const ROUTES = {
  // hourly: the answer changes with the full hour
  '/api/start': { names: ['ch'], hourly: true, maxAge: 60 },
  '/api/details': { names: ['ch'], hourly: true, maxAge: 300 },
  '/api/day': { names: ['ch', 'date'], hourly: false, maxAge: 300 },
};

// -> { status, body?, etag?, maxAge? }; body is built lazily, so a 304 costs no query.
export function route(store, url, now) {
  if (url.length > MAX_URL) return { status: 414 };
  if (!URL.canParse(url, 'http://localhost')) return { status: 400 };
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  const r = ROUTES[pathname];
  if (!r) return { status: 404 };
  const query = parseQuery(searchParams, r.names);
  const ids = query && parseIds(query.ch, pathname === '/api/day' ? 1 : MAX_CHANNELS);
  if (!ids || (query.date !== undefined && !DATE.test(query.date))) return { status: 400 };
  const etag = `${FORMAT}.${store.built}${r.hourly ? `.${Math.floor(now / HOUR)}` : ''}`;
  let body;
  if (pathname === '/api/start') body = () => store.start(ids, now);
  else if (pathname === '/api/details') body = () => store.details(ids, now);
  else {
    const day = store.day(ids[0], query.date);
    if (day === null) return { status: 404 };
    body = () => day;
  }
  return { status: 200, etag, maxAge: r.maxAge, body };
}

const ERRORS = { 400: 'bad request', 404: 'not found', 405: 'method not allowed', 414: 'uri too long' };

function encoding(accept = '') {
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return '';
}

function compress(body, enc) {
  if (enc === 'br') return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  return enc === 'gzip' ? gzipSync(body) : body;
}

const matches = (header = '', etag) =>
  header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*');

// dbFile is looked at on every request: after a build the new file is opened,
// and while it cannot be read the previous one keeps answering.
export function createHandler(dbFile, clock = Date.now) {
  let store = null;
  let stamp = '';
  let lastError = '';
  function current() {
    try {
      const s = statSync(dbFile);
      const now = `${s.ino}:${s.mtimeMs}:${s.size}`;
      if (now !== stamp) {
        const next = openStore(dbFile);
        store?.close();
        store = next;
        stamp = now;
      }
    } catch (e) {
      if (!store) throw e;
    }
    return store;
  }

  const fail = (res, status, headers = {}) =>
    res
      .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      .end(JSON.stringify({ error: ERRORS[status] ?? 'unavailable' }));

  function answer(req, res) {
    const r = route(current(), req.url, clock());
    if (r.status !== 200) return fail(res, r.status);
    const enc = encoding(req.headers['accept-encoding']);
    const headers = {
      'cache-control': `public, max-age=${r.maxAge}`,
      etag: `"${r.etag}${enc && `.${enc}`}"`,
      vary: 'Accept-Encoding',
    };
    if (matches(req.headers['if-none-match'], headers.etag)) return res.writeHead(304, headers).end();
    const body = compress(Buffer.from(r.body()), enc);
    if (enc) headers['content-encoding'] = enc;
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
  }

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, { allow: 'GET, HEAD' });
    try {
      answer(req, res);
    } catch (e) {
      // Once per kind of failure, not once per request.
      if (e.message !== lastError) console.error(e.message);
      lastError = e.message;
      if (!res.headersSent) fail(res, 503);
      else res.destroy();
    }
  };
}

if (import.meta.main) {
  const file = process.env.TV_DB;
  const port = Number(process.env.PORT);
  if (!file || !port) throw new Error('TV_DB and PORT are required');
  const server = createServer({ maxHeaderSize: 8192 }, createHandler(file));
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.timeout = 10_000;
  server.listen(port, '127.0.0.1', () => console.info(`tv api on 127.0.0.1:${port}, ${file}`));
}
