import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { log } from '@moxxy/companion-services';
import type { ModuleKernel, WsHub } from '@moxxy/companion-core/server';

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
 * The one api server: /api REST (the kernel's dynamic route table + RBAC),
 * /ws SPA socket (upgrade, session-token auth), GitHub webhooks (HMAC auth),
 * and the built SPA as static files (dev uses Vite with a proxy instead). By
 * default it binds 127.0.0.1; Docker sets the host to 0.0.0.0 so published
 * ports work.
 */
export function startHttpServer(opts: {
  host: string;
  port: number;
  kernel: ModuleKernel;
  hub: WsHub;
  /** Directory of the built SPA (apps/web/dist); optional in dev. */
  staticDir?: string;
  /** Out-of-tree module id -> absolute path of its prebuilt browser chunk. */
  moduleChunks?: ReadonlyMap<string, string>;
}): Promise<Server> {
  const { host, port, kernel, hub, staticDir, moduleChunks } = opts;

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    // Unauthenticated liveness probe for Docker/Coolify/uptime monitors.
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path.startsWith('/api/')) {
      void kernel.router.dispatch(req, res);
      return;
    }
    // An out-of-tree module's browser chunk. Unauthenticated by necessity: this
    // is fetched by `import()`, which cannot carry a bearer token, and it is
    // code rather than data, exactly like the SPA bundle served below. The map
    // is built at boot from validated modules, so a request cannot name a path.
    if (path.startsWith('/modules/')) {
      serveModuleChunk(moduleChunks, path, res);
      return;
    }
    // Raw-body routes (webhooks) — self-authenticating, byte-exact bodies, owned
    // by whichever module registered them. The shell stays module-agnostic: it
    // asks the kernel's raw router, which 503s a disabled owner's path and
    // reports "not handled" for anything else so we fall through to static.
    if (kernel.rawRouter.active) {
      void kernel.rawRouter.tryDispatch(req, res).then((handled) => {
        if (handled) return;
        if (staticDir) return serveStatic(staticDir, path, res);
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('companion api: no static bundle (use the Vite dev server)');
      });
      return;
    }
    if (staticDir) {
      serveStatic(staticDir, path, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('companion api: no static bundle (use the Vite dev server)');
  });

  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info(`listening on http://${host}:${port}`);
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

/**
 * `/modules/<id>/client.js` -> the file the module declared as `moxxy.client`.
 *
 * Lookup by id in a map the kernel already validated, never a path join against
 * the request: the URL contributes an id and nothing else, so there is no
 * traversal to defend against. `no-cache` rather than `immutable` because a
 * module can be reinstalled at the same version during development, and the
 * `?v=` the loader appends already busts the cache on a real upgrade.
 */
function serveModuleChunk(
  chunks: ReadonlyMap<string, string> | undefined,
  path: string,
  res: import('node:http').ServerResponse,
): void {
  const [, , id, file] = path.split('/');
  const abs = id && file === 'client.js' ? chunks?.get(id) : undefined;
  if (!abs || !existsSync(abs)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such module chunk');
    return;
  }
  res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'no-cache' });
  createReadStream(abs).pipe(res);
}
