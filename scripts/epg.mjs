// Reines Parsen und Auswählen, ohne Netz und Dateisystem – damit testbar.
// XMLTV ist flach und regelmäßig genug für reguläre Ausdrücke; ein echter
// XML-Parser wäre bei 60 MB pro Feed deutlich langsamer.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decode(s) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e] ?? m;
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    })
    .replace(/\\n/g, '\n')
    .trim();
}

// "20260930181500 +0000" -> ms seit Epoche
export function parseTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-])(\d\d)(\d\d)/.exec(s);
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, se, sign, oh, om] = m;
  const off = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  return Date.UTC(+y, mo - 1, +d, +h, +mi, +se) - off * 60000;
}

const partsFmt = new Map();
function zoneParts(ms, tz) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsFmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

// Lokale Wandzeit in einer Zeitzone -> ms. Zwei Schritte reichen, weil 20:15
// nie in eine Zeitumstellung fällt.
export function zonedToEpoch(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = zoneParts(guess, tz);
  const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess;
  return guess - off;
}

export function isoDate(ms, tz) {
  const p = zoneParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function hhmm(ms, tz) {
  const p = zoneParts(ms, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

export function slug(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/&amp;/g, '')
    .replace(/[^a-z0-9+]/g, '');
}

export function parseChannels(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<channel id="([^"]+)">[\s\S]*?<display-name[^>]*>([^<]+)</g)) {
    out.set(decode(m[1]), decode(m[2]));
  }
  return out;
}

export function* programmes(xml) {
  const re = /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">([\s\S]*?)<\/programme>/g;
  for (const m of xml.matchAll(re)) {
    yield { start: parseTime(m[1]), stop: parseTime(m[2]), channel: decode(m[3]), body: m[4] };
  }
}

const one = (body, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(body);
  return m ? decode(m[1]) : '';
};
const all = (body, tag) =>
  [...body.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map((m) => decode(m[1]));

// Crew, die manche Feeds fälschlich als <actor> führen.
const NOT_A_ROLE = /^(schnitt|kamera|musik|drehbuch|regie|produktion|buch)$/i;

export function parseBody(body) {
  const actors = [...body.matchAll(/<actor(?: role="([^"]*)")?>([^<]*)<\/actor>/g)]
    .filter((m) => !(m[1] && NOT_A_ROLE.test(decode(m[1]))))
    .map((m) => (m[1] ? { n: decode(m[2]), r: decode(m[1]) } : { n: decode(m[2]) }));
  const icon = /<icon src="([^"]+)"/.exec(body);
  const rating = /<rating system="IMDB">\s*<value>([^<]+)<\/value>/.exec(body);
  const year = /^\d{4}/.exec(one(body, 'date'));
  return {
    title: one(body, 'title'),
    sub: one(body, 'sub-title'),
    desc: one(body, 'desc'),
    year: year ? Number(year[0]) : null,
    genres: all(body, 'category'),
    directors: all(body, 'director'),
    actors,
    country: one(body, 'country'),
    episode: one(body, 'episode-num'),
    img: icon ? decode(icon[1]).replace(/^http:\/\//, 'https://') : '',
    rating: rating ? Number.parseFloat(rating[1]) || null : null,
  };
}

const EMPTY = /kein programm|sendepause|programmhinweis/i;

export function isReal(p) {
  return p.title !== '' && !EMPTY.test(p.title) && !EMPTY.test(p.desc.slice(0, 60));
}

// Titel für den Abgleich zweier Feeds: Satzzeichen und Groß/Klein egal.
export const titleKey = (t) => slug(t).slice(0, 24);

// Ergänzt fehlende Felder aus einem zweiten Feed, ohne vorhandene zu
// überschreiben. Die Feeds sind unterschiedlich gut: DE hat Jahr und
// IMDb-Wertung, AT oft die Besetzung.
export function enrich(a, b) {
  if (!b || titleKey(a.title) !== titleKey(b.title)) return a;
  const out = { ...a };
  for (const k of ['sub', 'desc', 'country', 'episode', 'img']) if (!out[k]) out[k] = b[k];
  for (const k of ['year', 'rating']) if (out[k] == null) out[k] = b[k];
  for (const k of ['genres', 'directors', 'actors']) if (!out[k].length) out[k] = b[k];
  if (b.desc.length > out.desc.length * 2) out.desc = b.desc;
  return out;
}
