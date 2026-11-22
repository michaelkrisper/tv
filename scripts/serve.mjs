// Serves dist/ locally with gzip like the live site, so transfer sizes match
// in tests too, and passes /api/ on to the API service, as Caddy does: the
// binary is built from server/ and started here. Port via PORT, default 8080.

import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const DIST = path('../dist/');
const PORT = Number(process.env.PORT) || 8080;
const BIN = path('../.cache/tv-api');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};
const TEXT = new Set(['.html', '.js', '.json', '.webmanifest', '.svg']);

execFileSync('go', ['build', '-o', BIN, '.'], { cwd: path('../server/'), stdio: 'inherit' });
const api = spawn(BIN, [], {
  env: { TV_DATA: process.env.TV_DATA || path('../.db/tv.tsv'), PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
api.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM', 'exit']) process.on(signal, () => api.kill());
// Its first line names the port it picked.
const apiPort = await new Promise((resolve) => {
  api.stdout.once('data', (line) => resolve(Number(/:(\d+),/.exec(String(line))[1])));
});

function proxy(req, res) {
  const options = {
    host: '127.0.0.1',
    port: apiPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  };
  const up = request(options, (answer) => {
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
}

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  let file = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (file.endsWith('/')) file += 'index.html';
  const ext = extname(file);
  let body;
  try {
    body = await readFile(join(DIST, file));
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
