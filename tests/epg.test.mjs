import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decode,
  enrich,
  hhmm,
  isoDate,
  isReal,
  parseBody,
  parseChannels,
  parseTime,
  prettyName,
  programmes,
  slug,
  titleKey,
  zonedToEpoch,
} from '../scripts/epg.mjs';

const TZ = 'Europe/Vienna';

test('decode: entities and literal \\n', () => {
  assert.equal(decode('Tom &amp; Jerry &#8211; &#x41;\\nZwei'), 'Tom & Jerry – A\nZwei');
});

test('parseTime removes the UTC offset', () => {
  assert.equal(parseTime('20260930181500 +0000'), Date.UTC(2026, 8, 30, 18, 15));
  assert.equal(parseTime('20260930201500 +0200'), Date.UTC(2026, 8, 30, 18, 15));
});

test('20:15 Vienna in summer and winter time', () => {
  assert.equal(zonedToEpoch(2026, 9, 30, 20, 15, TZ), Date.UTC(2026, 8, 30, 18, 15));
  assert.equal(zonedToEpoch(2026, 12, 24, 20, 15, TZ), Date.UTC(2026, 11, 24, 19, 15));
  // Month overflow, as build.mjs uses it for "today + i"
  assert.equal(isoDate(zonedToEpoch(2026, 9, 31, 20, 15, TZ), TZ), '2026-10-01');
  assert.equal(hhmm(Date.UTC(2026, 8, 30, 18, 15), TZ), '20:15');
});

test('slug normalises channel names', () => {
  assert.equal(slug('ORF III'), 'orfiii');
  assert.equal(slug('Servus TV Österreich'), 'servustvoesterreich');
  assert.equal(slug('ORF SPORT +'), 'orfsport+');
});

const XML = `<programme start="20260930181500 +0000" stop="20260930205500 +0000" channel="kabel.eins.de">
    <title lang="de">Aladdin</title>
    <desc lang="de">Ein Dieb &amp; ein Dschinn.\\n\\nMit Musik.</desc>
    <credits>
      <director>Guy Ritchie</director>
      <actor role="Genie">Will Smith</actor>
      <actor role="Schnitt">James Herbert</actor>
      <actor>Naomi Scott</actor>
    </credits>
    <date>2019</date>
    <category lang="de">Abenteuer</category>
    <icon src="http://img.tvspielfilm.de/f8/x.jpeg" />
    <rating system="IMDB">
      <value>6.9</value>
    </rating>
  </programme>`;

test('programmes + parseBody', () => {
  const [p] = [...programmes(XML)];
  assert.equal(p.channel, 'kabel.eins.de');
  assert.equal(p.stop - p.start, 160 * 60000);
  const b = parseBody(p.body);
  assert.equal(b.title, 'Aladdin');
  assert.equal(b.desc, 'Ein Dieb & ein Dschinn.\n\nMit Musik.');
  assert.equal(b.year, 2019);
  assert.equal(b.rating, 6.9);
  assert.equal(b.img, 'https://img.tvspielfilm.de/f8/x.jpeg');
  assert.deepEqual(b.directors, ['Guy Ritchie']);
  assert.deepEqual(b.actors, [{ n: 'Will Smith', r: 'Genie' }, { n: 'Naomi Scott' }]);
  assert.ok(isReal(b));
});

test('placeholders without a title or "kein Programm" are dropped', () => {
  const base = parseBody('<title>x</title>');
  assert.ok(!isReal({ ...base, title: '' }));
  assert.ok(!isReal({ ...base, desc: 'Momentan ist kein Programm geplant.' }));
});

test('enrich fills only gaps and only for the same title', () => {
  const a = {
    ...parseBody('<title>Rosamunde Pilcher: Vier Luftballons</title><date>2021</date><desc>kurz</desc>'),
  };
  const b = parseBody(
    '<title>Rosamunde Pilcher - Vier Luftballons</title><desc>eine deutlich längere Beschreibung</desc><actor>Meriel Hinsching</actor>',
  );
  const m = enrich(a, b);
  assert.equal(m.year, 2021);
  assert.deepEqual(m.actors, [{ n: 'Meriel Hinsching' }]);
  assert.equal(m.desc, 'eine deutlich längere Beschreibung');
  assert.equal(enrich(a, { ...b, title: 'Etwas anderes' }), a);
});

test('decode keeps unknown entities and trims', () => {
  assert.equal(decode('  a&nbsp;b &quot;c&quot; '), 'a&nbsp;b "c"');
});

test('parseTime rejects malformed timestamps', () => {
  assert.ok(Number.isNaN(parseTime('2026-09-30 18:15')));
  assert.ok(Number.isNaN(parseTime('')));
});

test('isoDate and hhmm use the local date around midnight', () => {
  // 23:30 UTC on 31 Dec is already New Year in Vienna (CET, +1).
  const ms = Date.UTC(2026, 11, 31, 23, 30);
  assert.equal(isoDate(ms, TZ), '2027-01-01');
  assert.equal(hhmm(ms, TZ), '00:30');
});

test('parseChannels maps ids to decoded display names', () => {
  const xml = `<tv>
    <channel id="ORF1.at">
      <display-name lang="de">ORF 1</display-name>
    </channel>
    <channel id="Tele&amp;5.de"><display-name>Tele 5 &amp; Co</display-name></channel>
  </tv>`;
  assert.deepEqual(
    [...parseChannels(xml)],
    [
      ['ORF1.at', 'ORF 1'],
      ['Tele&5.de', 'Tele 5 & Co'],
    ],
  );
});

test('parseBody without optional fields', () => {
  const b = parseBody(
    '<title>Nachrichten</title><date>unbekannt</date><rating system="IMDB"><value>n/a</value></rating>',
  );
  assert.equal(b.title, 'Nachrichten');
  assert.equal(b.year, null);
  assert.equal(b.rating, null);
  assert.equal(b.img, '');
  assert.deepEqual(b.genres, []);
  assert.deepEqual(b.actors, []);
});

test('isReal drops "Sendepause" titles and notices at the start of the description', () => {
  const base = parseBody('<title>x</title>');
  assert.ok(!isReal({ ...base, title: 'Sendepause' }));
  assert.ok(!isReal({ ...base, desc: 'Programmhinweis: heute geändert' }));
  assert.ok(isReal({ ...base, desc: `${'a'.repeat(60)} kein Programm` }));
});

test('titleKey ignores punctuation, case and long suffixes', () => {
  assert.equal(titleKey('Tatort: Der Fall'), titleKey('TATORT - Der Fall'));
  assert.equal(titleKey('x'.repeat(40)).length, 24);
});

test('enrich keeps the original without a second feed', () => {
  const a = parseBody('<title>Tatort</title>');
  assert.equal(enrich(a, undefined), a);
  assert.equal(enrich(a, null), a);
});

test('prettyName lowercases shouted words but keeps abbreviations', () => {
  assert.equal(prettyName('OBERÖSTERREICH TV'), 'Oberösterreich TV');
  assert.equal(prettyName('ORF SPORT +'), 'ORF Sport +');
  assert.equal(prettyName('SKY CINEMA ACTION'), 'Sky Cinema Action');
  // Mixed case and short all-caps names are left alone.
  assert.equal(prettyName('ServusTV'), 'ServusTV');
  assert.equal(prettyName('ORF 2'), 'ORF 2');
});

test('programmes yields every entry with a decoded channel id', () => {
  const xml = ['a&amp;b', 'c'].map(
    (c) =>
      `<programme start="20260930180000 +0000" stop="20260930190000 +0000" channel="${c}"><title>x</title></programme>`,
  );
  assert.deepEqual(
    [...programmes(xml.join('\n'))].map((p) => p.channel),
    ['a&b', 'c'],
  );
});

test('parseBody treats a non-numeric IMDb rating as missing', () => {
  const b = parseBody('<title>x</title><rating system="IMDB"><value>N/A</value></rating>');
  assert.equal(b.rating, null);
});
