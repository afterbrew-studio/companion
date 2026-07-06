import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { log } from '../log.js';
import { handleApi, readRawBody, type RestDeps } from './rest.js';
import type { SpaHub } from './spa-ws.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * The one companiond server: /api REST, /ws SPA socket (upgrade), and the
 * built SPA as static files (dev uses Vite with a proxy instead). Binds
 * 127.0.0.1 only — loopback is the trust boundary.
 */
export function startHttpServer(opts: {
  port: number;
  deps: RestDeps;
  hub: SpaHub;
  /** Directory of the built SPA (apps/web/dist); optional in dev. */
  staticDir?: string;
}): Promise<Server> {
  const { port, deps, hub, staticDir } = opts;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith('/api/')) {
      void handleApi(req, res, deps);
      return;
    }
    // GitHub webhook deliveries: HMAC over the RAW body, so this route never
    // goes through the JSON parser. No bearer — the signature IS the auth.
    const webhook = path.match(/^\/webhooks\/github\/([\w.-]+)\/([\w.-]+)$/);
    if (webhook && req.method === 'POST') {
      void readRawBody(req)
        .then((raw) => {
          const result = deps.automations.handleDelivery(`${webhook[1]}/${webhook[2]}`, req.headers, raw);
          res.writeHead(result.status, { 'content-type': 'text/plain' });
          res.end(result.body);
        })
        .catch((err) => {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(String(err));
        });
      return;
    }
    if (staticDir) {
      serveStatic(staticDir, path, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('companiond: no static bundle (use the Vite dev server)');
  });

  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log.info(`listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

function serveStatic(root: string, path: string, res: import('node:http').ServerResponse): void {
  let file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html'); // SPA fallback
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
