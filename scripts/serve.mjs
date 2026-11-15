// Serves dist/ locally with gzip like the live site, so transfer sizes match
// in tests too, and answers /api/ like the API service behind Caddy does.
// Port via PORT, default 8080. NO_API=1 leaves the API out (static files only).

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHandler } from '../server/api.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const api = process.env.NO_API
  ? null
  : createHandler(process.env.TV_DB || fileURLToPath(new URL('../.db/tv.db', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const TEXT = new Set(['.html', '.js', '.json', '.webmanifest', '.svg']);

createServer(async (req, res) => {
  if (api && req.url.startsWith('/api/')) return api(req, res);
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path.endsWith('/')) path += 'index.html';
  const ext = extname(path);
  let body;
  try {
    body = await readFile(join(DIST, path));
  } catch {
    res.writeHead(404).end();
    return;
  }
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': 'max-age=600',
  };
  if (TEXT.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    body = gzipSync(body);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(200, headers).end(body);
}).listen(PORT, () => console.info(`http://localhost:${PORT}/`));
