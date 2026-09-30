import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decode,
  enrich,
  hhmm,
  isoDate,
  isReal,
  parseBody,
  parseTime,
  programmes,
  slug,
  zonedToEpoch,
} from '../scripts/epg.mjs';

const TZ = 'Europe/Vienna';

test('decode: Entitäten und wörtliche \\n', () => {
  assert.equal(decode('Tom &amp; Jerry &#8211; &#x41;\\nZwei'), 'Tom & Jerry – A\nZwei');
});

test('parseTime rechnet den Offset heraus', () => {
  assert.equal(parseTime('20260930181500 +0000'), Date.UTC(2026, 8, 30, 18, 15));
  assert.equal(parseTime('20260930201500 +0200'), Date.UTC(2026, 8, 30, 18, 15));
});

test('20:15 Wien in Sommer- und Winterzeit', () => {
  assert.equal(zonedToEpoch(2026, 9, 30, 20, 15, TZ), Date.UTC(2026, 8, 30, 18, 15));
  assert.equal(zonedToEpoch(2026, 12, 24, 20, 15, TZ), Date.UTC(2026, 11, 24, 19, 15));
  // Monatsüberlauf, wie ihn build.mjs für "heute + i" nutzt
  assert.equal(isoDate(zonedToEpoch(2026, 9, 31, 20, 15, TZ), TZ), '2026-10-01');
  assert.equal(hhmm(Date.UTC(2026, 8, 30, 18, 15), TZ), '20:15');
});

test('slug vereinheitlicht Sendernamen', () => {
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

test('Platzhalter ohne Titel oder "kein Programm" fliegen raus', () => {
  const base = parseBody('<title>x</title>');
  assert.ok(!isReal({ ...base, title: '' }));
  assert.ok(!isReal({ ...base, desc: 'Momentan ist kein Programm geplant.' }));
});

test('enrich füllt nur Lücken und nur bei gleichem Titel', () => {
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
