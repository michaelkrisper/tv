// Holt die XMLTV-Feeds, schneidet für jeden Sender die Sendung heraus, die um
// 20:15 läuft, verkleinert die Bilder und schreibt alles nach dist/.
//
//   node scripts/build.mjs            voll, mit Bildern
//   node scripts/build.mjs --no-img   schnell, ohne Bilder (lokales Testen)

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import {
  enrich,
  hhmm,
  isoDate,
  isReal,
  parseBody,
  parseChannels,
  programmes,
  slug,
  titleKey,
  zonedToEpoch,
} from './epg.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache');
const TZ = 'Europe/Vienna';
const HOUR = 20;
const MINUTE = 15;
const DAYS = 4;
const WITH_IMG = !process.argv.includes('--no-img');

// Reihenfolge = Vorrang: der erste Feed liefert die Sendung, weitere ergänzen.
const FEEDS = [
  { name: 'de', url: 'https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz' },
  { name: 'at', shouty: true, url: 'https://epgshare01.online/epgshare01/epg_ripper_AT1.xml.gz' },
];

// Gleiche Sender, anders geschrieben. Schlüssel und Wert sind slug()s.
const ALIAS = {
  dasersteard: 'daserste',
  orf3: 'orfiii',
  'orfsport1+': 'orfsport+',
  disney: 'disneychannel',
  fixfoxitv: 'fixfoxi',
  kinowelt: 'kinowelttv',
  motorvision: 'motorvisiontv',
  oe24: 'oe24tv',
  skycinemaaction: 'skycinemaactionhd',
  skycinemafamily: 'skycinemafamilyhd',
  skyshowcase: 'skyshowcasehd',
  swr: 'swrsr',
  pro7: 'prosieben',
  pro7maxx: 'prosiebenmaxx',
  pro7fun: 'prosiebenfun',
  rtl2: 'rtlzwei',
  rtlnitro: 'nitro',
  kabel1doku: 'kabeleinsdoku',
  kabel1classics: 'kabeleinsclassics',
  atv2: 'atvii',
  servustvoesterreich: 'servustv',
  tagesschau: 'tagesschau24',
  euronewsger: 'euronews',
  skyspoaustria: 'skysportaustria',
  nationalgeographic: 'natgeohd',
  nationalgeographicwild: 'natgeowild',
  discoverychannel: 'discoveryhd',
  universaltv: 'universalchannelhd',
  '13thstreetuniversal': '13thstreet',
  skyatlantik: 'skyatlantichd',
  cnninternational: 'cnn',
};

const NAMES = {
  servustv: 'ServusTV',
  arte: 'arte',
  daserste: 'Das Erste',
  prosieben: 'ProSieben',
  rtlzwei: 'RTLZWEI',
  kabeleins: 'kabel eins',
  orfiii: 'ORF III',
  atvii: 'ATV II',
  nitro: 'RTL NITRO',
  swrsr: 'SWR',
};

// Der AT-Feed schreibt alles groß: "OBERÖSTERREICH TV" -> "Oberösterreich TV".
// Kurze Wörter und Wörter mit Ziffern sind meist Kürzel und bleiben.
function prettyName(n) {
  if (n !== n.toUpperCase() || !/[A-ZÄÖÜ]{4}/.test(n)) return n;
  return n.replace(/[A-ZÄÖÜ]{4,}/g, (w) => w[0] + w.slice(1).toLowerCase()).replace(/\bSKY\b/, 'Sky');
}

const HIDDEN = /beate|playboy|lust pur|adult|myteamtv|fussball\.tv|^sky sport (bundesliga|austria)? ?\d/i;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (url.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
}

function targets(now) {
  const out = [];
  const today = isoDate(now, TZ);
  for (let i = 0; i < DAYS; i++) {
    const [y, m, d] = today.split('-').map(Number);
    const at = zonedToEpoch(y, m, d + i, HOUR, MINUTE, TZ);
    out.push({ date: isoDate(at, TZ), at });
  }
  return out;
}

// channelId -> date -> Programm
function collect(xml, days, shouty) {
  const names = parseChannels(xml);
  const byChannel = new Map();
  for (const p of programmes(xml)) {
    const day = days.find((d) => p.start <= d.at && d.at < p.stop);
    if (!day) continue;
    const name = names.get(p.channel);
    if (!name || HIDDEN.test(name)) continue;
    const info = parseBody(p.body);
    // Manche Feeds führen den Episodentitel als Kategorie.
    info.genres = info.genres.filter((g) => !info.title.includes(g) && g !== info.sub);
    if (!isReal(info)) continue;
    const s = slug(name);
    const id = ALIAS[s] ?? s;
    if (!byChannel.has(id))
      byChannel.set(id, { name: NAMES[id] ?? (shouty ? prettyName(name) : name), days: new Map() });
    byChannel.get(id).days.set(day.date, { ...info, start: p.start, stop: p.stop });
  }
  return byChannel;
}

function merge(feeds) {
  const [base, ...rest] = feeds;
  const out = new Map(base);
  for (const feed of rest) {
    for (const [id, ch] of feed) {
      const have = out.get(id);
      if (!have) {
        out.set(id, ch);
        continue;
      }
      for (const [date, p] of ch.days) {
        const mine = have.days.get(date);
        have.days.set(date, mine ? enrich(mine, p) : p);
      }
    }
  }
  return out;
}

// ---- Bilder ---------------------------------------------------------------

const SIZES = { s: [320, 180], l: [960, 540] };

// Vorverkleinertes JPEG als Ausgangsmaterial. fairu skaliert selbst; für alle
// anderen (TV Spielfilm liefert bis zu 6 MB große Originale) übernimmt das
// wsrv.nl – nur hier im Build, nie im Browser.
function sourceUrl(src) {
  if (src.includes('files.fairu.app')) return `${src.split('?')[0]}?width=960&format=jpg&quality=92`;
  return `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=960&we&output=jpg&q=92`;
}

const exists = (f) =>
  stat(f).then(
    (s) => s.size > 0,
    () => false,
  );

// AVIF ist bei gleicher Anmutung rund ein Drittel kleiner als WebP. effort 2
// statt Standard 4: siebenmal schneller, nur ~4 % größer.
async function fetchImage(src, hash) {
  const files = Object.fromEntries(
    Object.keys(SIZES).map((k) => [k, join(CACHE, 'img', `${hash}-${k}.avif`)]),
  );
  if ((await Promise.all(Object.values(files).map(exists))).every(Boolean)) return files;
  const res = await fetch(sourceUrl(src), { signal: AbortSignal.timeout(60_000) });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('image/')) throw new Error(`${res.status} ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Gleich auf 16:9 zuschneiden, wie es angezeigt wird; "attention" hält
  // Gesichter und Motiv im Bild statt stur die Mitte.
  for (const [k, [width, height]] of Object.entries(SIZES)) {
    await sharp(buf)
      .resize({ width, height, fit: 'cover', position: sharp.strategy.attention })
      .avif({ quality: 50, effort: 2 })
      .toFile(files[k]);
  }
  return files;
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: n }, worker));
}

async function images(channels) {
  const bySrc = new Map();
  for (const ch of channels.values())
    for (const p of ch.days.values()) {
      if (!p.img) continue;
      const hash = createHash('sha1').update(p.img).digest('hex').slice(0, 12);
      bySrc.set(p.img, hash);
      p.img = hash;
    }
  if (!WITH_IMG) {
    for (const ch of channels.values()) for (const p of ch.days.values()) p.img = '';
    return;
  }
  await mkdir(join(CACHE, 'img'), { recursive: true });
  await mkdir(join(DIST, 'img'), { recursive: true });
  const failed = new Set();
  await pool([...bySrc], 8, async ([src, hash]) => {
    try {
      const files = await fetchImage(src, hash);
      for (const [size, file] of Object.entries(files))
        await cp(file, join(DIST, 'img', `${hash}-${size}.avif`));
    } catch (e) {
      failed.add(hash);
      console.warn(`Bild ${src}: ${e.message}`);
    }
  });
  for (const ch of channels.values()) for (const p of ch.days.values()) if (failed.has(p.img)) p.img = '';
  console.info(`Bilder: ${bySrc.size - failed.size} ok, ${failed.size} fehlgeschlagen`);
}

// ---- Ausgabe --------------------------------------------------------------

const detail = (p) => ({
  k: titleKey(p.title),
  sub: p.sub || undefined,
  desc: p.desc || undefined,
  genres: p.genres.length ? p.genres : undefined,
  dir: p.directors.length ? p.directors : undefined,
  cast: p.actors.length ? p.actors.slice(0, 12) : undefined,
  country: p.country || undefined,
  ep: p.episode || undefined,
});

async function write(channels, days) {
  const ids = [...channels.keys()].sort((a, b) =>
    channels.get(a).name.localeCompare(channels.get(b).name, 'de'),
  );
  const list = {
    built: Date.now(),
    days: days.map((d) => d.date),
    channels: ids.map((id) => [id, channels.get(id).name]),
    items: {},
  };
  await mkdir(join(DIST, 'data'), { recursive: true });
  const thisYear = Number(days[0].date.slice(0, 4));
  for (const { date } of days) {
    const items = {};
    const details = {};
    for (const id of ids) {
      const p = channels.get(id).days.get(date);
      if (!p) continue;
      // Bei aktuellen Shows ist das Jahr nur Rauschen; bei Filmen (mit
      // Besetzung) bleibt es, auch wenn es das laufende ist.
      const year = p.year === thisYear && !p.actors.length ? null : p.year;
      // Kurze Schlüssel: die Liste wird bei jedem Start gelesen.
      items[id] = [p.title, hhmm(p.start, TZ), hhmm(p.stop, TZ), p.genres[0] ?? '', year, p.img, p.rating];
      details[id] = detail(p);
    }
    list.items[date] = items;
    await writeFile(join(DIST, 'data', `${date}.json`), JSON.stringify(details));
  }
  await writeFile(join(DIST, 'data', 'list.json'), JSON.stringify(list));

  // Version über die Hülle, nicht über die Daten: sonst holt jedes Gerät nach
  // jedem Daten-Build die ganze Hülle neu.
  const hash = createHash('sha1');
  for (const f of [
    'index.html',
    'manifest.webmanifest',
    'icon.svg',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable.png',
  ]) {
    await cp(join(ROOT, 'src', f), join(DIST, f));
    hash.update(await readFile(join(ROOT, 'src', f)));
  }
  const sw = await readFile(join(ROOT, 'src', 'sw.js'), 'utf8');
  const version = hash.update(sw).digest('hex').slice(0, 10);
  await writeFile(join(DIST, 'sw.js'), sw.replace('__VERSION__', version));
  await writeFile(join(DIST, '.nojekyll'), '');
}

async function main() {
  const now = Date.now();
  const days = targets(now);
  await rm(DIST, { recursive: true, force: true });
  const feeds = [];
  for (const f of FEEDS) {
    const t = performance.now();
    const xml = await fetchText(f.url);
    feeds.push(collect(xml, days, f.shouty));
    console.info(`${f.name}: ${feeds.at(-1).size} Sender in ${Math.round(performance.now() - t)} ms`);
  }
  const channels = merge(feeds);
  for (const [id, ch] of channels) if (!ch.days.size) channels.delete(id);
  await images(channels);
  await write(channels, days);
  const today = days[0].date;
  const n = [...channels.values()].filter((c) => c.days.has(today)).length;
  console.info(`${channels.size} Sender, heute (${today}) ${n} mit 20:15-Sendung`);
  if (n < 20) throw new Error('Zu wenige Sender für heute – Quelle kaputt? Nicht ausliefern.');
}

await main();
