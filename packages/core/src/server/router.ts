import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AuthUser, Authenticator, Permission, RouteAccess } from '@moxxy/companion-contracts';
import { withRequestUser, type Logger } from '@moxxy/companion-services';
import type { AuditEvent } from './capabilities.js';

/**
 * The typed route factory + the dynamic router. A `route({...})` value declares
 * its method, path pattern, required permission and (optionally) a zod body
 * schema; path params are inferred from the pattern at the type level and the
 * permission is enforced centrally — a route cannot forget auth. The
 * `DynamicRouter` mounts/unmounts a module's routes live, answering a disabled
 * module's known path with 503 (vs 404 for a genuinely unknown path).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `'/a/:x/b/:y'` → `'x' | 'y'` */
type ParamNames<P extends string> = P extends `${string}:${infer Param}/${infer Rest}`
  ? Param | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Param}`
    ? Param
    : never;

export type PathParams<P extends string> = { readonly [K in ParamNames<P>]: string };

/**
 * Base for errors whose HTTP status the dispatcher is allowed to forward to the
 * client. ONLY subclasses of this (HttpError here, module-core's AuthError)
 * status-map; any other thrown error — e.g. a GitHubError carrying an upstream
 * 401/403 — becomes a logged 500, so a rejected PAT can never masquerade as a
 * Companion session-expiry / RBAC denial.
 */
export class StatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpError extends StatusError {}

export const notFound = (what: string): HttpError => new HttpError(404, what);
export const badRequest = (why: string): HttpError => new HttpError(400, why);
export const forbidden = (why: string): HttpError => new HttpError(403, why);

/** Wrap a handler's return value to send a non-200 status, or a non-JSON body. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    /**
     * Set to send `body` verbatim instead of JSON-encoding it. The body may be
     * one string or an AsyncIterable of byte/string chunks for bounded exports.
     */
    readonly contentType?: string,
    /** Extra response headers. `Location` for a redirect is the only current use. */
    readonly headers?: Readonly<Record<string, string>>,
  ) {}
}

export const created = (body: unknown): Reply => new Reply(201, body);
export const accepted = (body: unknown): Reply => new Reply(202, body);
/** A downloadable, non-JSON document (NDJSON export, CSV, …). */
export const document = (body: string, contentType: string, filename?: string): Reply =>
  new Reply(200, body, contentType, filename ? { 'content-disposition': `attachment; filename="${filename}"` } : undefined);
/** A bounded-memory downloadable document; chunks are written with backpressure. */
export const documentStream = (
  body: AsyncIterable<string | Uint8Array>,
  contentType: string,
  filename?: string,
): Reply =>
  new Reply(200, body, contentType, filename ? { 'content-disposition': `attachment; filename="${filename}"` } : undefined);

/** Send the browser elsewhere. Needed by handshakes that run before any session exists. */
export const redirect = (location: string, status: 302 | 303 = 302): Reply =>
  new Reply(status, '', 'text/plain; charset=utf-8', { location });

export interface RouteContext<P extends string, B> {
  readonly params: PathParams<P>;
  readonly query: URLSearchParams;
  readonly body: B;
  /** Resolved user; null only on 'public' routes. */
  readonly user: AuthUser | null;
  /** Raw bearer token of this request (for logout-style flows). */
  readonly token: string | null;
}

export interface RouteDef<P extends string, B> {
  readonly method: HttpMethod;
  readonly path: P;
  readonly access: RouteAccess;
  /** Input pinned to `unknown` so B infers from the schema OUTPUT (defaults applied). */
  readonly body?: z.ZodType<B, z.ZodTypeDef, unknown>;
  readonly handler: (ctx: RouteContext<P, B>) => Promise<unknown> | unknown;
}

export interface CompiledRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly regex: RegExp;
  readonly keys: readonly string[];
  readonly access: RouteAccess;
  /** Owning module id, tagged by the kernel on mount (for 503 attribution). */
  moduleId?: string;
  readonly run: (
    params: Record<string, string>,
    query: URLSearchParams,
    rawBody: unknown,
    user: AuthUser | null,
    token: string | null,
  ) => Promise<unknown>;
}

/** Route factory: captures the body schema + param typing, erases generics. */
export function route<P extends string, B = Record<string, never>>(def: RouteDef<P, B>): CompiledRoute {
  const { regex, keys } = compilePath(def.path);
  return {
    method: def.method,
    path: def.path,
    regex,
    keys,
    access: def.access,
    run: async (params, query, rawBody, user, token) => {
      const body = (def.body ? def.body.parse(rawBody) : {}) as B;
      return def.handler({ params: params as PathParams<P>, query, body, user, token });
    },
  };
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

// ---------- dynamic dispatch ------------------------------------------------------

/** An error carrying an HTTP status (AuthError, HttpError, …) — duck-typed so
 *  core need not import each module's error class. */
function statusOf(err: unknown): number | null {
  if (err instanceof StatusError) return err.status;
  // Duck-typed rather than an import: a transport that talks to a third party
  // (the GitHub client) says what the CLIENT should be told without depending
  // on this router. Answering 500 for an upstream outage makes somebody else's
  // hiccup read as our own crash, and sends whoever sees it looking here.
  const upstream = (err as { clientStatus?: unknown }).clientStatus;
  return typeof upstream === 'number' && upstream >= 400 && upstream < 600 ? upstream : null;
}

/** Seconds a failed request is worth retrying after, when the error says so. */
function retryAfterOf(err: unknown): number | null {
  const after = (err as { retryAfter?: unknown }).retryAfter;
  return typeof after === 'number' && after > 0 ? after : null;
}

export class DynamicRouter {
  /** Enabled modules' routes, by module id. Dispatch reads a flattened snapshot. */
  private readonly mounted = new Map<string, readonly CompiledRoute[]>();
  private flat: readonly CompiledRoute[] = [];
  /** Patterns owned by installed-but-disabled modules → 503 (not 404). */
  private disabled = new Map<string, readonly CompiledRoute[]>();
  private disabledFlat: readonly CompiledRoute[] = [];

  constructor(
    private readonly auth: Authenticator,
    private readonly log: Logger,
    /** Emits one record per mutating request; the kernel swallows sink failures. */
    private readonly audit: (event: AuditEvent) => void = () => {},
  ) {}

  mount(moduleId: string, routes: readonly CompiledRoute[]): void {
    for (const r of routes) {
      // First match wins in dispatch, so a path claimed by two modules would
      // silently route to whichever mounted first. Refuse instead of guessing.
      const clash = this.flat.find((m) => m.method === r.method && m.path === r.path && m.moduleId !== moduleId);
      if (clash) {
        throw new HttpError(409, `route ${r.method} ${r.path} is already mounted by module '${clash.moduleId}'`);
      }
    }
    for (const r of routes) r.moduleId = moduleId;
    this.mounted.set(moduleId, routes);
    this.disabled.delete(moduleId);
    this.recompute();
  }

  /** Move a module's (already-tagged) routes to the disabled set — their paths answer 503. */
  unmount(moduleId: string): void {
    const routes = this.mounted.get(moduleId);
    this.mounted.delete(moduleId);
    if (routes?.length) this.disabled.set(moduleId, routes);
    this.recompute();
  }

  /** Drop a module's disabled-set patterns entirely — an uninstalled path is 404, not 503. */
  forget(moduleId: string): void {
    this.disabled.delete(moduleId);
    this.recompute();
  }

  private recompute(): void {
    this.flat = [...this.mounted.values()].flat();
    this.disabledFlat = [...this.disabled.values()].flat();
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET') as HttpMethod;
    const path = url.pathname;
    /** The route we committed to, so the catch block can audit a refusal. */
    let matched: CompiledRoute | null = null;

    try {
      let pathMatched = false;
      for (const r of this.flat) {
        const match = r.regex.exec(path);
        if (!match) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        matched = r;

        const token = bearerToken(req, url);
        const user = this.auth.verify(token);
        if (r.access !== 'public') {
          if (r.access === 'any') {
            if (!user) throw new HttpError(401, 'authentication required');
          } else {
            this.auth.require(user, r.access as Permission);
          }
        }

        const params: Record<string, string> = {};
        r.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match[i + 1] ?? '');
        });
        const rawBody = method === 'GET' ? {} : await readBody(req);
        const result = await withRequestUser(user, () => r.run(params, url.searchParams, rawBody, user, token));
        const status = result instanceof Reply ? result.status : 200;
        // AFTER the handler: recording an attempt that then threw would claim
        // changes that never happened. Failures are audited in sendError, with
        // their real status.
        this.recordIfMutating(r, user, status);
        if (result instanceof Reply) {
          await send(res, result);
          return;
        }
        return json(res, 200, result);
      }
      if (pathMatched) return json(res, 405, { error: `method ${method} not allowed on ${path}` });
      // A disabled module owns this path → 503 with attribution, not 404.
      for (const r of this.disabledFlat) {
        if (r.regex.test(path)) return json(res, 503, { error: 'module disabled', module: r.moduleId });
      }
      return json(res, 404, { error: `no route: ${method} ${path}` });
    } catch (err) {
      // A refused mutation is exactly what an auditor wants to see, so record it
      // with the status the client got. `matched` is null when nothing matched.
      const status = statusOf(err) ?? (err instanceof z.ZodError ? 400 : 500);
      if (matched) this.recordIfMutating(matched, this.actorOf(req, url), status);
      return sendError(res, err, method, path, this.log);
    }
  }

  /** Reads are not audited: they would bury the writes and the table is append-only. */
  private recordIfMutating(route: CompiledRoute, user: AuthUser | null, status: number): void {
    if (route.method === 'GET') return;
    this.audit({
      at: Date.now(),
      actor: user?.username ?? null,
      action: `${route.method} ${route.path}`,
      access: route.access as string,
      status,
      module: route.moduleId ?? null,
    });
  }

  /** Best-effort actor for the failure path; a bad token simply audits as null. */
  private actorOf(req: IncomingMessage, url: URL): AuthUser | null {
    try {
      return this.auth.verify(bearerToken(req, url));
    } catch {
      return null;
    }
  }
}

function sendError(res: ServerResponse, err: unknown, method: string, path: string, log: Logger): void {
  if (err instanceof z.ZodError) {
    return json(res, 400, { error: 'invalid request', issues: err.issues });
  }
  const status = statusOf(err);
  if (status !== null) {
    const retryAfter = retryAfterOf(err);
    if (retryAfter !== null) res.setHeader('retry-after', String(retryAfter));
    return json(res, status, {
      error: err instanceof Error ? err.message : String(err),
      ...(retryAfter !== null ? { retryAfter } : {}),
    });
  }
  log.warn('request failed', { method, path, err: String(err) });
  return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

export function bearerToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return url.searchParams.get('token');
}

/** A Reply carries JSON, one verbatim string, or an async byte/string stream. */
async function send(res: ServerResponse, reply: Reply): Promise<void> {
  if (reply.contentType && isAsyncIterable(reply.body)) {
    res.writeHead(reply.status, { 'content-type': reply.contentType, ...reply.headers });
    try {
      for await (const chunk of reply.body) {
        if (res.destroyed) return;
        if (!res.write(chunk) && !(await waitForDrain(res))) return;
      }
      res.end();
    } catch (err) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }
  if (!reply.contentType || typeof reply.body !== 'string') {
    json(res, reply.status, reply.body);
    return;
  }
  const raw = Buffer.from(reply.body, 'utf8');
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': raw.byteLength,
    ...reply.headers,
  });
  res.end(raw);
}

/** Wait for backpressure without hanging when the downloader disconnects. */
function waitForDrain(res: ServerResponse): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (drained: boolean): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(drained);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string | Uint8Array> {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

/** Raw-body reader for webhook HMAC verification (bytes must be exact). */
export async function readRawBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
