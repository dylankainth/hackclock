// Tiny static server for dist/ (used by the browser tests and for quick local runs).
// Usage: node tools/serve.mjs [port]   ->   http://localhost:8080
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function serve(dir, port = 0, host = '127.0.0.1', tls = null) {
  const handler = async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  };
  const server = tls ? createHttps(tls, handler) : createHttp(handler);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../dist/', import.meta.url).pathname;
  const port = Number(process.argv[2]) || 8080;
  const s = await serve(dir, port, '0.0.0.0');
  console.log(`Serving dist/ on http://localhost:${s.address().port}`);
}
