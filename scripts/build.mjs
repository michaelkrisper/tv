// Fetches the XMLTV feeds, extracts the 20:15 programme and the daily schedule
// for "Jetzt" for every channel, fetches the channel logos and writes the
// programme file for the API and dist/img/. The app shell in dist/ is only written when it changed.
//
// It also builds the images of the next 24 hours and of the 20:15 programmes ahead; all other
// images the app loads live through the resize services (fairu itself,
// otherwise wsrv.nl).

import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { createData } from './data.mjs';
import {
  enrich,
  hhmm,
  isoDate,
  isReal,
  parseBody,
  parseChannels,
  prettyName,
  programmes,
  slug,
  thumbName,
  zonedToEpoch,
} from './epg.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache');
// Not inside dist/: the programme is read by the API service, never served as a file.
const DATA = process.env.TV_DATA || join(ROOT, '.db', 'tv.tsv');
const TZ = 'Europe/Vienna';
const HOUR = 20;
const MINUTE = 15;
const DAYS = 3;
// Daily schedule for all days: "Jetzt" needs today and tomorrow (after
// midnight, before the next build runs), 20:15 needs it for "Danach".
const NOW_SPAN = 30 * 3600_000;

// Order = priority: the first feed provides the programme, later ones fill gaps.
const FEEDS = [
  { name: 'de', url: 'https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz' },
  { name: 'at', shouty: true, url: 'https://epgshare01.online/epgshare01/epg_ripper_AT1.xml.gz' },
];

// Same channels, spelled differently. Keys and values are slug()s.
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

// channelId -> { days: date -> 20:15 programme, sched: date -> programmes }
function collect(xml, days, shouty) {
  const names = parseChannels(xml);
  const byChannel = new Map();
  for (const p of programmes(xml)) {
    const day = days.find((d) => p.start <= d.at && d.at < p.stop);
    // Daily schedule for "Jetzt": everything from 00:00 until 06:00 the next
    // morning, so the day's file is still enough after midnight.
    const inSched = days.filter((d) => p.stop > d.from && p.start < d.from + NOW_SPAN);
    if (!day && !inSched.length) continue;
    const name = names.get(p.channel);
    if (!name || HIDDEN.test(name)) continue;
    const info = parseBody(p.body);
    // Some feeds list the episode title as a category.
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
      // Do not mix schedules: only take one where the first feed has none.
      for (const [date, list] of ch.sched) if (!have.sched.has(date)) have.sched.set(date, list);
    }
  }
  return out;
}

// ---- Helpers -------------------------------------------------------------

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

// ---- Channel logos -------------------------------------------------------

// Open logo collection; files are named e.g. countries/austria/orf2-at.png.
const LOGO_TREE = 'https://api.github.com/repos/tv-logo/tv-logos/git/trees/main?recursive=1';
const LOGO_RAW = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/';
const LOGO_ALIAS = { orfiii: 'orf3', 'orfsport+': 'orfsportplus', atvii: 'atv2', nitro: 'rtlnitro' };

async function logoIndex() {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const res = await fetch(LOGO_TREE, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Logo directory: ${res.status}`);
  const index = new Map();
  for (const { path } of (await res.json()).tree) {
    const m = /^countries\/(?:austria|germany|switzerland)\/(hd\/)?(.+?)(?:-hd)?-(?:at|de|ch)\.png$/.exec(
      path,
    );
    if (!m) continue;
    const key = m[2].replace(/-/g, '');
    // Austria first (tree order), and without "HD" before with.
    const have = index.get(key);
    if (!have || (have.hd && !m[1])) index.set(key, { path, hd: !!m[1] });
  }
  return index;
}

// Logos sit transparently on the thumbnail with a dark shadow. That works for
// white and coloured logos; only mostly near-black ones need a light glow
// instead ('k').
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
    console.warn(`Logos skipped: ${e.message}`);
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
  console.info(`Logos: ${found} of ${channels.size} channels`);
}

// ---- Images --------------------------------------------------------------

// What starts within this time after the build gets its images built ahead;
// own() in src/index.html uses the same 24 hours. CI sets fewer.
const AHEAD = Number(process.env.TV_AHEAD ?? 24) * 3_600_000;
// Thumbnail for the lists and a detail image as wide as a phone screen.
const SIZES = { t: { width: 320, height: 180, quality: 65 }, h: { width: 1080, height: 608, quality: 70 } };

// Images from the app's own server: dist/img/t/<thumbName> for the 20:15
// programmes of all days, and t/ plus h/ for everything running within AHEAD.
// The original is fetched once (up to 6 MB) and downsized here. Files are kept
// in .cache/img between builds: only new programmes cost requests, the ones no
// longer wanted are removed. A missing one is not an error: the app then loads
// it live, as it does for all later programmes.
async function images(channels, days, built) {
  const want = { t: new Set(), h: new Set() };
  for (const ch of channels.values()) {
    for (const d of days) {
      const src = ch.days.get(d.date)?.img.replace(/^https:\/\//, '');
      if (src && thumbName(src)) want.t.add(src);
      for (const p of ch.sched.get(d.date) ?? []) {
        const s = p.img.replace(/^https:\/\//, '');
        if (!s || !thumbName(s) || p.stop <= built || p.start >= built + AHEAD) continue;
        want.t.add(s);
        want.h.add(s);
      }
    }
  }
  await rm(join(CACHE, 'thumb'), { recursive: true, force: true });
  for (const k of ['t', 'h']) {
    const names = new Set([...want[k]].map(thumbName));
    await mkdir(join(CACHE, 'img', k), { recursive: true });
    await mkdir(join(DIST, 'img', k), { recursive: true });
    for (const f of await readdir(join(CACHE, 'img', k))) {
      if (!names.has(f)) await rm(join(CACHE, 'img', k, f), { force: true });
    }
  }
  let fetched = 0;
  const ready = { t: 0, h: 0 };
  const failed = new Map();
  await pool([...want.t], 8, async (src) => {
    const name = thumbName(src);
    const kinds = ['t', 'h'].filter((k) => want[k].has(src));
    try {
      const todo = [];
      for (const k of kinds) if (!(await exists(join(CACHE, 'img', k, name)))) todo.push(k);
      if (todo.length) {
        const res = await fetch(`https://${src}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(res.status);
        // The largest size is cut from the original, the smaller one from that
        // result: the same crop, and the costly step runs once.
        let from = Buffer.from(await res.arrayBuffer());
        for (const k of ['h', 't'].filter((x) => kinds.includes(x))) {
          const { quality, ...size } = SIZES[k];
          const cut = sharp(from).resize({
            ...size,
            fit: 'cover',
            position: 'attention',
            withoutEnlargement: true,
          });
          if (todo.includes(k))
            await cut
              .clone()
              .webp({ quality })
              .toFile(join(CACHE, 'img', k, name));
          if (k === 'h') from = await cut.png({ compressionLevel: 0 }).toBuffer();
        }
        fetched++;
      }
      for (const k of kinds) {
        // With the time kept, rsync leaves unchanged images alone.
        await cp(join(CACHE, 'img', k, name), join(DIST, 'img', k, name), { preserveTimestamps: true });
        ready[k]++;
      }
    } catch (e) {
      for (const k of kinds) await rm(join(CACHE, 'img', k, name), { force: true });
      const why = /^\d+$/.test(e.message) ? e.message : 'not readable';
      failed.set(why, (failed.get(why) ?? 0) + 1);
    }
  });
  const why = [...failed].map(([m, n]) => `, ${n} failed: ${m}`).join('');
  console.info(
    `Images: ${ready.t} of ${want.t.size} thumbnails, ${ready.h} of ${want.h.size} detail images (${fetched} fetched${why})`,
  );
}

// ---- Output --------------------------------------------------------------

const detail = (p) => ({
  sub: p.sub || undefined,
  desc: p.desc || undefined,
  genres: p.genres.length ? p.genres : undefined,
  dir: p.directors.length ? p.directors : undefined,
  cast: p.actors.length ? p.actors.slice(0, 12) : undefined,
  country: p.country || undefined,
  ep: p.episode || undefined,
});

// The full schedule per channel and day, times in minutes from 00:00.
// Images as source URLs; the app derives the built file or the live URL. Every row
// goes into the programme file with its details.
function writeSchedules(channels, ids, days, thisYear, data) {
  for (const d of days) {
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
      const x = sorted.map(detail);
      out.forEach((row, k) => {
        data.sched(d.date, id, row, x[k]);
      });
    }
  }
}

// iPhone screens (CSS px and pixel ratio, portrait) for the launch image of the
// installed app: iOS only shows one that matches the device exactly.
const SPLASH = [
  [440, 956, 3],
  [420, 912, 3],
  [402, 874, 3],
  [430, 932, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [414, 896, 3],
  [375, 812, 3],
  [414, 896, 2],
  [375, 667, 2],
];
const SPLASH_BG = { dark: '#101218', light: '#f4f5f8' };

// Writes the launch images and returns their <link> tags for index.html.
async function splash() {
  await mkdir(join(DIST, 'splash'), { recursive: true });
  const links = [];
  for (const [w, h, r] of SPLASH) {
    const icon = await sharp(join(ROOT, 'src', 'icon-512.png'))
      .resize(128 * r)
      .toBuffer();
    for (const [scheme, background] of Object.entries(SPLASH_BG)) {
      const file = `splash/${w * r}x${h * r}-${scheme}.png`;
      await sharp({ create: { width: w * r, height: h * r, channels: 3, background } })
        .composite([{ input: icon }])
        .png({ palette: true, compressionLevel: 9 })
        .toFile(join(DIST, file));
      links.push(
        `<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})" href="${file}">`,
      );
    }
  }
  return links.join('\n');
}

async function write(channels, days, built) {
  const ids = [...channels.keys()].sort((a, b) =>
    channels.get(a).name.localeCompare(channels.get(b).name, 'de'),
  );
  const thisYear = Number(days[0].date.slice(0, 4));
  const data = createData(
    DATA,
    {
      built,
      channels: ids.map((id) => [id, channels.get(id).name, channels.get(id).logo ?? '']),
    },
    days,
  );
  for (const { date, from } of days) {
    for (const id of ids) {
      const p = channels.get(id).days.get(date);
      if (!p) continue;
      // For current shows the year is just noise; for films (with a cast)
      // it stays, even if it is the current year.
      const year = p.year === thisYear && !p.actors.length ? null : p.year;
      // Positional: the API sends these rows as they are on every start.
      const row = [
        p.title,
        hhmm(p.start, TZ),
        hhmm(p.stop, TZ),
        p.genres[0] ?? '',
        year,
        p.img.replace(/^https:\/\//, ''),
        p.rating,
      ];
      data.item(date, id, Math.round((p.stop - from) / 60000), row, detail(p));
    }
  }
  writeSchedules(channels, ids, days, thisYear, data);
  data.close();
}

const SHELL = ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'];

// The shell (page, worker, icons, launch images) only depends on the code and
// the version: a data build leaves it alone while .cache/shell says it is
// current.
async function shell() {
  const version = process.env.APP_VERSION || 'dev';
  const stamp = createHash('sha1').update(version);
  for (const f of ['scripts/build.mjs', 'src/index.html', 'src/sw.js', ...SHELL.map((f) => `src/${f}`)]) {
    stamp.update(await readFile(join(ROOT, f)));
  }
  const id = stamp.digest('hex');
  const mark = join(CACHE, 'shell');
  const have = await readFile(mark, 'utf8').catch(() => '');
  if (have === id && (await exists(join(DIST, 'index.html')))) return false;
  await rm(mark, { force: true });
  for (const f of await readdir(DIST)) if (f !== 'img') await rm(join(DIST, f), { recursive: true });

  // Worker version from the shell, not the data; otherwise every device would
  // refetch the whole shell after every data build.
  const hash = createHash('sha1');
  // Same version tag the deploy gives this commit; local builds show "dev".
  const html = (await readFile(join(ROOT, 'src', 'index.html'), 'utf8'))
    .replace('<!-- splash -->', await splash())
    .replace('<!-- version -->', version);
  await writeFile(join(DIST, 'index.html'), html);
  hash.update(html);
  for (const f of SHELL) {
    await cp(join(ROOT, 'src', f), join(DIST, f));
    hash.update(await readFile(join(ROOT, 'src', f)));
  }
  const sw = await readFile(join(ROOT, 'src', 'sw.js'), 'utf8');
  await writeFile(join(DIST, 'sw.js'), sw.replace('__VERSION__', hash.update(sw).digest('hex').slice(0, 10)));
  await mkdir(CACHE, { recursive: true });
  await writeFile(mark, id);
  return true;
}

async function main() {
  const now = Date.now();
  const days = targets(now);
  // Everything in dist/img/ comes from the data and is written again.
  await rm(join(DIST, 'img'), { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  const feeds = [];
  for (const f of FEEDS) {
    const t = performance.now();
    const xml = await fetchText(f.url);
    feeds.push(collect(xml, days, f.shouty));
    console.info(`${f.name}: ${feeds.at(-1).size} channels in ${Math.round(performance.now() - t)} ms`);
  }
  const channels = merge(feeds);
  for (const [id, ch] of channels) if (!ch.days.size) channels.delete(id);
  await logos(channels);
  const built = Date.now();
  await images(channels, days, built);
  await write(channels, days, built);
  console.info(`Shell: ${(await shell()) ? 'written' : 'unchanged'}`);
  const today = days[0].date;
  const n = [...channels.values()].filter((c) => c.days.has(today)).length;
  console.info(`${channels.size} channels, today (${today}) ${n} with a 20:15 programme`);
  if (n < 20) throw new Error('Too few channels for today - source broken? Not deploying.');
}

await main();
