// Writes the programme into one file for the read-only API (server/main.go),
// which keeps all of it in memory: one line of JSON with the build, the days
// and the channels, then one line per 20:15 item and schedule row, fields
// separated by tabs. Rows and details are the JSON the API sends as it is
// (JSON has no raw tabs or line breaks). The file is replaced atomically: the
// service keeps the previous one until the new one is complete.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Raise together with format in server/main.go when the layout changes.
export const FORMAT = 2;

// list: { built, channels: [[id, name, logo]] }; days: [{ date, from }] (from = 00:00 of that day in ms)
export function createData(file, { built, channels }, days) {
  const meta = { format: FORMAT, built, days: days.map(({ date, from }) => ({ date, from })), channels };
  const lines = [JSON.stringify(meta)];
  const json = JSON.stringify;
  return {
    // stop, like the schedule's start/stop: minutes from 00:00 of the day
    item: (date, ch, stop, row, detail) =>
      lines.push(['i', date, ch, stop, json(row), json(detail)].join('\t')),
    sched: (date, ch, row, detail) =>
      lines.push(['s', date, ch, row[0], row[1], json(row), json(detail)].join('\t')),
    close() {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${lines.join('\n')}\n`);
      renameSync(tmp, file);
    },
  };
}
