// Holt die XMLTV-Feeds, schneidet für jeden Sender die 20:15-Sendung und das
// Tagesprogramm für "Jetzt" heraus, holt die Senderlogos und schreibt nach dist/.
//
// Vorschaubilder verarbeitet der Build nicht: die App lädt sie live über die
// Resize-Dienste (fairu selbst, sonst wsrv.nl).

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
// Für "Jetzt": heute und morgen (nach Mitternacht, bevor der nächste Build läuft).
const NOW_DAYS = 2;
const NOW_SPAN = 30 * 3600_000;

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
    out.push({ date: isoDate(at, TZ), at, from: zonedToEpoch(y, m, d + i, 0, 0, TZ) });
  }
  return out;
}

function channelEntry(byChannel, id, name) {
  if (!byChannel.has(id)) byChannel.set(id, { name, days: new Map(), sched: new Map() });
  return byChannel.get(id);
}

// channelId -> { days: date -> 20:15-Programm, sched: date -> Programme }
function collect(xml, days, shouty) {
  const names = parseChannels(xml);
  const byChannel = new Map();
  const nowDays = days.slice(0, NOW_DAYS);
  for (const p of programmes(xml)) {
    const day = days.find((d) => p.start <= d.at && d.at < p.stop);
    // Tagesprogramm für "Jetzt": alles, was von 0 Uhr bis 6 Uhr früh am
    // Folgetag läuft, damit auch nach Mitternacht die Datei des Tages reicht.
    const inSched = nowDays.filter((d) => p.stop > d.from && p.start < d.from + NOW_SPAN);
    if (!day && !inSched.length) continue;
    const name = names.get(p.channel);
    if (!name || HIDDEN.test(name)) continue;
    const info = parseBody(p.body);
    // Manche Feeds führen den Episodentitel als Kategorie.
    info.genres = info.genres.filter((g) => !info.title.includes(g) && g !== info.sub);
    if (!isReal(info)) continue;
    const s = slug(name);
    const id = ALIAS[s] ?? s;
    const ch = channelEntry(byChannel, id, NAMES[id] ?? (shouty ? prettyName(name) : name));
    const prog = { ...info, start: p.start, stop: p.stop };
    if (day) ch.days.set(day.date, prog);
    for (const d of inSched) {
      if (!ch.sched.has(d.date)) ch.sched.set(d.date, []);
      ch.sched.get(d.date).push(prog);
    }
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
      // Tagesprogramme nicht mischen: nur übernehmen, wo der erste Feed keins hat.
      for (const [date, list] of ch.sched) if (!have.sched.has(date)) have.sched.set(date, list);
    }
  }
  return out;
}

// ---- Hilfen --------------------------------------------------------------

const exists = (f) =>
  stat(f).then(
    (s) => s.size > 0,
    () => false,
  );

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: n }, worker));
}

// ---- Senderlogos ----------------------------------------------------------

// Offene Logo-Sammlung; Dateien heißen z. B. countries/austria/orf2-at.png.
const LOGO_TREE = 'https://api.github.com/repos/tv-logo/tv-logos/git/trees/main?recursive=1';
const LOGO_RAW = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/';
const LOGO_ALIAS = { orfiii: 'orf3', 'orfsport+': 'orfsportplus', atvii: 'atv2', nitro: 'rtlnitro' };

async function logoIndex() {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const res = await fetch(LOGO_TREE, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Logo-Verzeichnis: ${res.status}`);
  const index = new Map();
  for (const { path } of (await res.json()).tree) {
    const m = /^countries\/(?:austria|germany|switzerland)\/(hd\/)?(.+?)(?:-hd)?-(?:at|de|ch)\.png$/.exec(
      path,
    );
    if (!m) continue;
    const key = m[2].replace(/-/g, '');
    // Österreich zuerst (Baumreihenfolge), und ohne "HD" vor mit.
    const have = index.get(key);
    if (!have || (have.hd && !m[1])) index.set(key, { path, hd: !!m[1] });
  }
  return index;
}

// Logos stehen transparent auf dem Vorschaubild, mit dunklem Schatten. Das
// trägt weiße und farbige Logos; nur überwiegend fast schwarze brauchen
// stattdessen einen hellen Schein ('k').
async function logoTone(file) {
  const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let black = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    if (max < 70 && max - min < 30) black += a;
    weight += a;
  }
  return weight > 0 && black / weight > 0.4 ? 'k' : 'w';
}

async function logos(channels) {
  let index;
  try {
    index = await logoIndex();
  } catch (e) {
    console.warn(`Logos übersprungen: ${e.message}`);
    return;
  }
  await mkdir(join(CACHE, 'logo'), { recursive: true });
  await mkdir(join(DIST, 'img'), { recursive: true });
  let found = 0;
  await pool([...channels.keys()], 8, async (id) => {
    const hit = index.get(LOGO_ALIAS[id] ?? id.replace('+', 'plus'));
    if (!hit) return;
    const file = join(CACHE, 'logo', `${id}.webp`);
    try {
      if (!(await exists(file))) {
        const res = await fetch(LOGO_RAW + hit.path, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(res.status);
        const trimmed = await sharp(Buffer.from(await res.arrayBuffer()))
          .trim()
          .png()
          .toBuffer();
        await sharp(trimmed)
          .resize({ height: 48, width: 160, fit: 'inside' })
          .webp({ quality: 90 })
          .toFile(file);
      }
      await cp(file, join(DIST, 'img', `logo-${id}.webp`));
      channels.get(id).logo = await logoTone(file);
      found++;
    } catch (e) {
      console.warn(`Logo ${id}: ${e.message}`);
    }
  });
  console.info(`Logos: ${found} von ${channels.size} Sendern`);
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

// "Jetzt": pro Sender und Tag das ganze Programm, Zeiten in Minuten ab 0 Uhr.
// Bilder als Quell-URL, die App lädt sie live und verkleinert. Die Details
// liegen daneben in <id>.x.json (gleiche Reihenfolge) und kommen erst beim
// Antippen – die Liste wird bei jedem Öffnen von "Jetzt" gelesen.
async function writeSchedules(channels, ids, days, thisYear) {
  for (const d of days.slice(0, NOW_DAYS)) {
    await mkdir(join(DIST, 'data', d.date), { recursive: true });
    for (const id of ids) {
      const progs = channels.get(id).sched.get(d.date);
      if (!progs) continue;
      const seen = new Set();
      const sorted = progs
        .sort((a, b) => a.start - b.start)
        .filter((p) => !seen.has(p.start) && seen.add(p.start));
      const out = sorted.map((p) => [
        Math.round((p.start - d.from) / 60000),
        Math.round((p.stop - d.from) / 60000),
        p.title,
        p.genres[0] ?? '',
        p.img.replace(/^https:\/\//, ''),
        p.year === thisYear && !p.actors.length ? null : p.year,
        p.rating,
      ]);
      const x = sorted.map((p) => {
        const { k, ...rest } = detail(p);
        return rest;
      });
      await writeFile(join(DIST, 'data', d.date, `${id}.json`), JSON.stringify(out));
      await writeFile(join(DIST, 'data', d.date, `${id}.x.json`), JSON.stringify(x));
    }
  }
}

async function write(channels, days) {
  const ids = [...channels.keys()].sort((a, b) =>
    channels.get(a).name.localeCompare(channels.get(b).name, 'de'),
  );
  const list = {
    built: Date.now(),
    days: days.map((d) => d.date),
    channels: ids.map((id) => [id, channels.get(id).name, channels.get(id).logo ?? '']),
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
      items[id] = [
        p.title,
        hhmm(p.start, TZ),
        hhmm(p.stop, TZ),
        p.genres[0] ?? '',
        year,
        p.img.replace(/^https:\/\//, ''),
        p.rating,
      ];
      details[id] = detail(p);
    }
    list.items[date] = items;
    await writeFile(join(DIST, 'data', `${date}.json`), JSON.stringify(details));
  }
  await writeFile(join(DIST, 'data', 'list.json'), JSON.stringify(list));

  await writeSchedules(channels, ids, days, thisYear);

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
  await logos(channels);
  await write(channels, days);
  const today = days[0].date;
  const n = [...channels.values()].filter((c) => c.days.has(today)).length;
  console.info(`${channels.size} Sender, heute (${today}) ${n} mit 20:15-Sendung`);
  if (n < 20) throw new Error('Zu wenige Sender für heute – Quelle kaputt? Nicht ausliefern.');
}

await main();
