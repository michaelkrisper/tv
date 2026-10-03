// Liefert dist/ lokal aus, mit gzip wie GitHub Pages: so stimmen die
// Datenmengen auch beim Testen. Port per PORT, Standard 8080.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
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
