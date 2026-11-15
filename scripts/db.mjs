// Writes the programme into one SQLite file for the read-only API
// (server/api.mjs). The rows hold the same JSON as the static data files, so
// both paths deliver the same format. The file is replaced atomically: the
// service keeps reading the previous one until the new one is complete.

import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Raise together with FORMAT in server/api.mjs when the tables change.
export const FORMAT = 1;

const SCHEMA = `
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE channel (pos INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, logo TEXT NOT NULL);
  -- stop: minutes from 00:00 of the day, like sched.start/stop
  CREATE TABLE item (date TEXT, ch TEXT, stop INTEGER NOT NULL, row TEXT NOT NULL, detail TEXT NOT NULL,
    PRIMARY KEY (date, ch));
  CREATE TABLE sched (date TEXT, ch TEXT, start INTEGER, stop INTEGER NOT NULL, row TEXT NOT NULL, detail TEXT NOT NULL,
    PRIMARY KEY (date, ch, start));
`;

// list: { built, channels } as in list.json; days: [{ date, from }] (from = 00:00 of that day in ms)
export function createDb(file, { built, channels }, days) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const meta = db.prepare('INSERT INTO meta VALUES (?, ?)');
  meta.run('format', String(FORMAT));
  meta.run('built', String(built));
  meta.run('days', JSON.stringify(days.map(({ date, from }) => ({ date, from }))));
  const channel = db.prepare('INSERT INTO channel VALUES (?, ?, ?, ?)');
  channels.forEach(([id, name, logo], pos) => {
    channel.run(pos, id, name, logo);
  });
  const item = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?, ?)');
  const sched = db.prepare('INSERT OR IGNORE INTO sched VALUES (?, ?, ?, ?, ?, ?)');
  return {
    item: (date, ch, stop, row, detail) =>
      item.run(date, ch, stop, JSON.stringify(row), JSON.stringify(detail)),
    sched: (date, ch, row, detail) =>
      sched.run(date, ch, row[0], row[1], JSON.stringify(row), JSON.stringify(detail)),
    close() {
      db.exec('COMMIT');
      db.close();
      renameSync(tmp, file);
    },
  };
}
