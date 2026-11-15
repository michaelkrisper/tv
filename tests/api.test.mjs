import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDb } from '../scripts/db.mjs';
import { createHandler, MAX_CHANNELS, openStore, parseIds, parseQuery, route } from '../server/api.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tv-api-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3600_000;
const DAY0 = Date.UTC(2026, 0, 10, 23); // 00:00 in Vienna
const DAYS = [
  { date: '2026-01-11', from: DAY0, at: 0 },
  { date: '2026-01-12', from: DAY0 + 24 * HOUR, at: 0 },
];
const CHANNELS = [
  ['3+', '3+', 'w'],
  ['arte', 'arte', ''],
  ['orf1', 'ORF 1', 'k'],
];

// Every channel: one programme per hour from 00:00 to 06:00 the next morning.
function fill(file, built = 1000) {
  const db = createDb(file, { built, channels: CHANNELS }, DAYS);
  for (const { date } of DAYS) {
    for (const [id] of CHANNELS) {
      for (let h = 0; h < 30; h++) {
        db.sched(date, id, [h * 60, h * 60 + 60, `${id} ${date} ${h}`, '', '', null, null], {
          desc: `d${h}`,
        });
      }
      // the 20:15 item runs from 20:00 to 21:00
      db.item(date, id, 21 * 60, [`${id} 20:15`, '20:00', '21:00', '', null, '', null], {
        desc: `${id} ${date}`,
      });
    }
  }
  db.close();
  return file;
}

const store = openStore(fill(join(dir, 'a.db')));
after(() => store.close());
const at = (h, m = 0) => DAY0 + h * HOUR + m * 60_000;

test('parseIds: only well-formed ids, sorted and unique', () => {
  assert.deepEqual(parseIds('orf1,3+,arte,orf1'), ['3+', 'arte', 'orf1']);
  for (const bad of [
    '',
    ',',
    'orf1,',
    'ORF1',
    'orf 1',
    "orf1'--",
    '../x',
    'a'.repeat(41),
    undefined,
    null,
    7,
  ]) {
    assert.equal(parseIds(bad), null, String(bad));
  }
  const many = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => `c${i}`);
  assert.equal(parseIds(many.join(',')), null);
  assert.equal(parseIds(many.slice(1).join(',')).length, MAX_CHANNELS);
  assert.equal(parseIds('a,b', 1), null);
});

test('parseQuery: exactly the expected parameters, each once', () => {
  const q = (s, names) => parseQuery(new URLSearchParams(s), names);
  assert.deepEqual(q('ch=a', ['ch']), { ch: 'a' });
  assert.deepEqual(q('date=d&ch=a', ['ch', 'date']), { ch: 'a', date: 'd' });
  assert.equal(q('', ['ch']), null);
  assert.equal(q('ch=a&ch=b', ['ch']), null);
  assert.equal(q('ch=a&x=1', ['ch']), null);
  assert.equal(q('ch=a', ['ch', 'date']), null);
});

test('start: selected channels only, schedule from the current full hour', () => {
  const r = JSON.parse(store.start(['arte', 'orf1', 'unknown'], at(21, 40)));
  assert.equal(r.built, 1000);
  assert.deepEqual(r.days, ['2026-01-11', '2026-01-12']);
  assert.deepEqual(r.channels, CHANNELS);
  assert.deepEqual(Object.keys(r.items), r.days);
  assert.deepEqual(Object.keys(r.items['2026-01-12']), ['arte', 'orf1']);
  assert.equal(r.items['2026-01-11'].orf1[0], 'orf1 20:15');
  assert.equal(r.sdate, '2026-01-11');
  assert.deepEqual(Object.keys(r.sched), ['arte', 'orf1']);
  // 21:00 until 06:00 the next morning
  assert.equal(r.sched.orf1.length, 9);
  assert.deepEqual(r.sched.orf1[0].slice(0, 3), [21 * 60, 22 * 60, 'orf1 2026-01-11 21']);
});

test('start: after midnight the new day is read, before the first day nothing', () => {
  const r = JSON.parse(store.start(['orf1'], at(24, 10)));
  assert.equal(r.sdate, '2026-01-12');
  assert.equal(r.sched.orf1[0][0], 0);
  const stale = JSON.parse(store.start(['orf1'], at(48 + 3)));
  assert.equal(stale.sdate, '2026-01-12');
  assert.equal(stale.sched.orf1[0][0], 27 * 60);
  const early = JSON.parse(store.start(['orf1'], at(-1)));
  assert.equal(early.sdate, null);
  assert.deepEqual(early.sched, {});
  assert.equal(Object.keys(early.items['2026-01-11']).length, 1);
});

test('start: no known channel gives empty lists, never other channels', () => {
  const r = JSON.parse(store.start(['nope'], at(12)));
  assert.deepEqual(r.items, { '2026-01-11': {}, '2026-01-12': {} });
  assert.deepEqual(r.sched, {});
});

test('details: 20:15 texts, "Danach" and the texts of the next hours', () => {
  const r = JSON.parse(store.details(['orf1'], at(18, 59)));
  assert.deepEqual(r.d['2026-01-12'], { orf1: { desc: 'orf1 2026-01-12' } });
  assert.deepEqual(
    r.n['2026-01-11'].orf1.map((p) => p[0]),
    [21 * 60, 22 * 60, 23 * 60],
  );
  assert.equal(r.sdate, '2026-01-11');
  assert.deepEqual(r.x, { orf1: { 1080: { desc: 'd18' }, 1140: { desc: 'd19' }, 1200: { desc: 'd20' } } });
});

test('day: one channel and day, texts in the order of the rows', () => {
  const r = JSON.parse(store.day('3+', '2026-01-12'));
  assert.equal(r.rows.length, 30);
  assert.equal(r.x.length, 30);
  assert.equal(r.rows[5][2], '3+ 2026-01-12 5');
  assert.deepEqual(r.x[5], { desc: 'd5' });
  assert.equal(store.day('nope', '2026-01-12'), null);
  assert.equal(store.day('orf1', '2026-01-13'), null);
});

test('route: validation and status codes', () => {
  const status = (url) => route(store, url, at(12)).status;
  assert.equal(status('/api/start?ch=orf1,3%2B'), 200);
  assert.equal(status('/api/details?ch=orf1'), 200);
  assert.equal(status('/api/day?ch=orf1&date=2026-01-11'), 200);
  assert.equal(status('/api/day?ch=orf1&date=2026-01-13'), 404);
  assert.equal(status('/api/day?ch=nope&date=2026-01-11'), 404);
  assert.equal(status('/api/day?ch=orf1,arte&date=2026-01-11'), 400);
  assert.equal(status('/api/day?ch=orf1&date=2026-1-11'), 400);
  assert.equal(status('/api/day?ch=orf1'), 400);
  assert.equal(status('/api/start'), 400);
  assert.equal(status('/api/start?ch=orf1&ch=arte'), 400);
  assert.equal(status('/api/start?ch=orf1&from=0'), 400);
  assert.equal(status('/api/start?ch=orf1%27%20OR%201=1'), 400);
  assert.equal(status('/api/start?ch=3+'), 400); // "+" must be sent as %2B
  assert.equal(status('/api/other?ch=orf1'), 404);
  assert.equal(status('/api/start/?ch=orf1'), 404);
  assert.equal(status(`/api/start?ch=${'a,'.repeat(3000)}a`), 414);
});

test('route: the ETag changes with the hour and the build only', () => {
  const tag = (url, t) => route(store, url, t).etag;
  assert.equal(tag('/api/start?ch=orf1', at(12, 1)), tag('/api/start?ch=orf1', at(12, 59)));
  assert.notEqual(tag('/api/start?ch=orf1', at(12)), tag('/api/start?ch=orf1', at(13)));
  assert.equal(
    tag('/api/day?ch=orf1&date=2026-01-11', at(12)),
    tag('/api/day?ch=orf1&date=2026-01-11', at(13)),
  );
});

test('http: compression, 304, methods, and a new database is picked up', async () => {
  const file = fill(join(dir, 'live.db'));
  let now = at(12);
  const server = createServer(createHandler(file, () => now));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/start?ch=orf1`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(res.headers.get('vary'), 'Accept-Encoding');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal((await res.json()).built, 1000);
    const etag = res.headers.get('etag');

    const again = (headers) => fetch(`${base}/api/start?ch=orf1`, { headers });
    const same = await again({ 'accept-encoding': 'br', 'if-none-match': `W/${etag}` });
    assert.equal(same.status, 304);
    assert.equal(same.headers.get('etag'), etag);
    assert.equal((await same.text()).length, 0);
    // another encoding is another representation
    const gz = await again({ 'accept-encoding': 'gzip', 'if-none-match': etag });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.notEqual(gz.headers.get('etag'), etag);
    await gz.arrayBuffer();
    const plain = await again({ 'accept-encoding': 'identity' });
    assert.equal(plain.headers.get('content-encoding'), null);
    await plain.arrayBuffer();

    now = at(13);
    assert.equal((await again({ 'accept-encoding': 'br', 'if-none-match': etag })).status, 200);

    const head = await fetch(`${base}/api/start?ch=orf1`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);
    const post = await fetch(`${base}/api/start?ch=orf1`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    const bad = await fetch(`${base}/api/start?ch=NOPE`);
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await bad.json(), { error: 'bad request' });

    fill(file, 2000);
    assert.equal((await (await again({})).json()).built, 2000);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('http: without a database the answer is 503', async () => {
  const server = createServer(createHandler(join(dir, 'missing.db')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/start?ch=orf1`);
    assert.equal(res.status, 503);
    await res.arrayBuffer();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
