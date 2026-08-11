import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { close, constants, createReadStream, fstat, open, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { isTrustedLocalHttpRequest, log } from '@moxxy/companion-services';
import type { AuthMode } from '@moxxy/companion-contracts';
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
  authMode: AuthMode;
  kernel: ModuleKernel;
  hub: WsHub;
  /** Directory of the built SPA (apps/web/dist); optional in dev. */
  staticDir?: string;
  /** Out-of-tree module id -> absolute path of its prebuilt browser chunk. */
  moduleChunks?: ReadonlyMap<string, string>;
  /** Enables Secure cookies/HSTS when TLS terminates at the reverse proxy. */
  publicUrl?: string;
}): Promise<Server> {
  const { host, port, authMode, kernel, hub, staticDir, moduleChunks, publicUrl } = opts;
  const inlineScriptHashes = staticDir ? cspInlineScriptHashes(join(staticDir, 'index.html')) : [];
  const staticFiles = staticDir ? indexStaticFiles(staticDir) : undefined;

  const server = createServer((req, res) => {
    setSecurityHeaders(req, res, publicUrl, inlineScriptHashes);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (authMode === 'local' && path === '/api/auth/local-session' && !isTrustedLocalHttpRequest({
      host: req.headers.host,
      origin: singleHeader(req.headers.origin),
      secFetchSite: singleHeader(req.headers['sec-fetch-site']),
    })) {
      const body = '{"error":"local session bootstrap requires a loopback browser origin"}';
      res.writeHead(403, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
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
        if (staticFiles) return serveStatic(staticFiles, path, res);
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('companion api: no static bundle (use the Vite dev server)');
      });
      return;
    }
    if (staticFiles) {
      serveStatic(staticFiles, path, res);
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

function setSecurityHeaders(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  publicUrl: string | undefined,
  inlineScriptHashes: readonly string[],
): void {
  const authority = /^[a-z0-9.\-\[\]:]+$/i.test(req.headers.host ?? '') ? req.headers.host! : 'localhost';
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `script-src 'self'${inlineScriptHashes.map((hash) => ` '${hash}'`).join('')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      `connect-src 'self' ws://${authority} wss://${authority}`,
      "font-src 'self'",
    ].join('; '),
  );
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (publicUrl?.startsWith('https://')) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

/** Vite injects one inline import map. Hash the exact built bytes instead of
 * weakening script-src with unsafe-inline. */
function cspInlineScriptHashes(indexFile: string): string[] {
  let html: string;
  try {
    html = readFileSync(indexFile, 'utf8');
  } catch {
    return [];
  }
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`sha256-${createHash('sha256').update(match[1] ?? '').digest('base64')}`);
  }
  return hashes;
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function indexStaticFiles(root: string): ReadonlyMap<string, string> {
  const base = resolve(root);
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.set(`/${relative(base, absolute).split(sep).join('/')}`, absolute);
      // A production bundle has no symlinks. Ignoring one keeps a replaced
      // artifact from escaping the indexed root later through a request.
    }
  };
  walk(base);
  return files;
}

function serveStatic(
  files: ReadonlyMap<string, string>,
  path: string,
  res: import('node:http').ServerResponse,
): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // The request only selects an entry from the boot-time index; it never
  // contributes a filesystem path. Still reject traversal-shaped URLs rather
  // than disguising them as an ordinary SPA fallback.
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) {
    res.writeHead(403);
    res.end();
    return;
  }
  const file = files.get(decoded === '/' ? '/index.html' : decoded) ?? files.get('/index.html');
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  serveFileDescriptor(file, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }, res);
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
  if (!abs) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such module chunk');
    return;
  }
  serveFileDescriptor(abs, { 'content-type': MIME['.js']!, 'cache-control': 'no-cache' }, res);
}

/**
 * Open without following a last-minute symlink, validate that exact inode,
 * then stream from the already-open descriptor.
 */
function serveFileDescriptor(
  file: string,
  headers: Readonly<Record<string, string>>,
  res: import('node:http').ServerResponse,
): void {
  open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), (openError, fd) => {
    if (openError) {
      res.writeHead(404);
      res.end();
      return;
    }
    fstat(fd, (statError, stat) => {
      if (statError || !stat.isFile()) {
        close(fd, () => undefined);
        res.writeHead(404);
        res.end();
        return;
      }
      const stream = createReadStream(file, { fd, autoClose: true });
      stream.once('error', (error) => {
        if (res.headersSent) res.destroy(error);
        else {
          res.writeHead(500);
          res.end();
        }
      });
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  });
}
