import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@moxxy/companion-services';
import { readRawBody, StatusError, type HttpMethod, type PathParams } from './router.js';

/**
 * Raw-body routes: the escape hatch for endpoints that must NOT go through the
 * JSON router — the request body is read as exact bytes and the route
 * authenticates itself (e.g. a GitHub webhook whose HMAC signature is computed
 * over the raw payload, so there is no bearer and no zod parse). They mount and
 * unmount with their module exactly like `route()`s, so the app shell never
 * names a specific module: it just asks the `RawRouter` to try the request.
 *
 * These deliberately bypass RBAC — a raw route owns its own auth. Keep them rare
 * (webhooks, upload tunnels); anything that fits the JSON + bearer model should
 * be a normal `route()` so it cannot forget auth.
 */

export interface RawRouteContext<P extends string> {
  readonly params: PathParams<P>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** The exact request bytes (never JSON-parsed). */
  readonly body: Buffer;
}

/** What a raw handler returns — written verbatim to the response. */
export interface RawReply {
  readonly status: number;
  readonly body: string;
  /** Defaults to text/plain. */
  readonly contentType?: string;
}

export interface RawRouteDef<P extends string> {
  readonly method: HttpMethod;
  readonly path: P;
  /** Max bytes to read before rejecting with 413 (defaults to 5 MiB). */
  readonly maxBytes?: number;
  readonly handler: (ctx: RawRouteContext<P>) => Promise<RawReply> | RawReply;
}

export interface CompiledRawRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly regex: RegExp;
  readonly keys: readonly string[];
  readonly maxBytes: number;
  /** Owning module id, tagged by the kernel on mount (for 503 attribution). */
  moduleId?: string;
  run(
    params: Record<string, string>,
    query: URLSearchParams,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Promise<RawReply>;
}

const SEGMENT = '([^/]+)';

function compilePath(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return SEGMENT;
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), keys };
}

/** Raw-route factory: mirrors `route()` but for byte bodies and self-auth. */
export function rawRoute<P extends string>(def: RawRouteDef<P>): CompiledRawRoute {
  const { regex, keys } = compilePath(def.path);
  return {
    method: def.method,
    path: def.path,
    regex,
    keys,
    maxBytes: def.maxBytes ?? 5 * 1024 * 1024,
    run: (params, query, headers, body) =>
      Promise.resolve(def.handler({ params: params as PathParams<P>, query, headers, body })),
  };
}

/**
 * The raw-route counterpart of `DynamicRouter`: same mount/unmount/forget
 * lifecycle (enabled → serve, disabled → 503, uninstalled → fall through to
 * 404), so raw routes toggle with their module just like JSON ones.
 */
export class RawRouter {
  private readonly mounted = new Map<string, readonly CompiledRawRoute[]>();
  private flat: readonly CompiledRawRoute[] = [];
  private readonly disabled = new Map<string, readonly CompiledRawRoute[]>();
  private disabledFlat: readonly CompiledRawRoute[] = [];

  constructor(private readonly log: Logger) {}

  mount(moduleId: string, routes: readonly CompiledRawRoute[]): void {
    if (!routes.length) return;
    for (const r of routes) r.moduleId = moduleId;
    this.mounted.set(moduleId, routes);
    this.disabled.delete(moduleId);
    this.recompute();
  }

  unmount(moduleId: string): void {
    const routes = this.mounted.get(moduleId);
    this.mounted.delete(moduleId);
    if (routes?.length) this.disabled.set(moduleId, routes);
    this.recompute();
  }

  forget(moduleId: string): void {
    this.disabled.delete(moduleId);
    this.recompute();
  }

  private recompute(): void {
    this.flat = [...this.mounted.values()].flat();
    this.disabledFlat = [...this.disabled.values()].flat();
  }

  /** True if any module (enabled or merely disabled) owns raw routes at all —
   *  lets the shell skip body handling entirely in the common case. */
  get active(): boolean {
    return this.flat.length > 0 || this.disabledFlat.length > 0;
  }

  /**
   * Handle `req` if it targets a raw route; returns whether it was handled so
   * the shell can fall through to static/404 when it wasn't. A path owned only
   * by a disabled module answers 503 (handled), never 404.
   */
  async tryDispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET') as HttpMethod;
    const path = url.pathname;

    let pathMatched = false;
    for (const r of this.flat) {
      if (!r.regex.test(path)) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const match = r.regex.exec(path)!;
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match[i + 1] ?? '');
        });
      } catch {
        // This surface is unauthenticated and internet-facing. A malformed
        // percent escape is a bad path, not an unhandled promise rejection.
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('malformed path parameter');
        return true;
      }
      try {
        const body = await readRawBody(req, r.maxBytes);
        const reply = await r.run(params, url.searchParams, req.headers, body);
        res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'text/plain' });
        res.end(reply.body);
      } catch (err) {
        this.log.warn('raw route failed', { method, path, err: String(err) });
        // Preserve deliberate framework statuses (notably the body reader's
        // 413), but never reflect an arbitrary handler/SQLite error to an
        // unauthenticated webhook caller.
        const status = err instanceof StatusError ? err.status : 500;
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(err instanceof StatusError ? err.message : 'raw route failed');
      }
      return true;
    }
    if (pathMatched) {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end(`method ${method} not allowed on ${path}`);
      return true;
    }
    // A disabled module owns this path → 503 (its raw endpoint is off), not 404.
    for (const r of this.disabledFlat) {
      if (r.regex.test(path)) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(`module disabled: ${r.moduleId}`);
        return true;
      }
    }
    return false;
  }
}
