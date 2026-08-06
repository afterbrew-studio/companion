import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  RUNNER_AGENT_PROTOCOL,
  type AgentCloneStatusRequest,
  type AgentCloneStatusResponse,
  type AgentCommandRequest,
  type AgentCommitRequest,
  type AgentDiffRequest,
  type AgentDiffResponse,
  type AgentEnsureCloneRequest,
  type AgentFetchRequest,
  type AgentEventMessage,
  type AgentHealth,
  type AgentPromptRequest,
  type AgentPushRequest,
  type AgentRemoveWorktreeRequest,
  type AgentScratchRequest,
  type AgentScratchResponse,
  type AgentSessionInfoResponse,
  type AgentSpawnRequest,
  type AgentStorageCleanupRequest,
  type AgentStorageCleanupResponse,
  type AgentVerifyRequest,
  type AgentVerifyResponse,
  type AgentWorktreeAtRequest,
  type AgentWorktreeRequest,
  type AgentWorktreeResponse,
  type AgentWriteFileRequest,
} from '@moxxy/companion-types';
import { paths } from '@moxxy/companion-services';
import type { Checkouts } from '@companion/module-operate/exec';
import { MIN_MOXXY_VERSION, runVerify } from '@companion/module-operate/exec';
import type { MoxxyCli } from '@companion/module-operate/exec';
import type { GatewayClient } from '@companion/module-operate/exec';
import type { GatewayPool } from '@companion/module-operate/exec';
import { cleanupRunnerStorage, loadHistoryWithFallback } from '@companion/module-operate/exec';
import type { Harness } from '@moxxy/companion-types';
import { RUNTIME_HARNESS_ID, type RuntimeSessions } from './runtime-sessions.js';
import { log } from './log.js';

/**
 * The agent's HTTP + WS surface: everything under `/agent/*`, bearer-token
 * auth (the runner token), plus `/agent/events` — one WS per controlling
 * companiond onto which every GatewayPool callback is broadcast as an
 * AgentEventMessage. Mirrors companiond's http/router style, just much
 * smaller: a handful of exact routes, no RBAC, no schema layer.
 */

export interface AgentDeps {
  readonly pool: GatewayPool;
  readonly checkouts: Checkouts;
  readonly moxxy: MoxxyCli | null;
  readonly maxRuns: number;
  /** The built-in runtime's live sessions on this machine (protocol 7). */
  readonly runtime: RuntimeSessions;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const badRequest = (why: string): HttpError => new HttpError(400, why);

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 1_000;

// ---------- event hub -------------------------------------------------------------

/** Fan-out of run events to every connected companiond (usually exactly one). */
export class EventHub {
  private readonly sockets = new Set<WebSocket>();

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => {
      this.sockets.delete(ws);
      ws.terminate();
    });
    this.send(ws, { t: 'hello', protocol: RUNNER_AGENT_PROTOCOL });
  }

  broadcast(msg: AgentEventMessage): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  close(): void {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
  }

  private send(ws: WebSocket, msg: AgentEventMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

// ---------- server ----------------------------------------------------------------

export function startAgentServer(opts: {
  host: string;
  port: number;
  token: string;
  deps: AgentDeps;
  hub: EventHub;
}): Promise<Server> {
  const { host, port, token, deps, hub } = opts;
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    void handle(req, res, token, deps);
  });

  // WS /agent/events?token=… — the run event stream companiond subscribes to.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent/events') {
      socket.destroy();
      return;
    }
    const presented = url.searchParams.get('token') ?? bearerToken(req);
    if (!tokenMatches(token, presented)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info(`agent listening on http://${host}:${port}`);
      resolve(server);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  deps: AgentDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  try {
    if (!path.startsWith('/agent/')) throw new HttpError(404, `no route: ${method} ${path}`);
    if (!tokenMatches(token, bearerToken(req))) throw new HttpError(401, 'invalid or missing token');
    const body = method === 'GET' ? {} : await readBody(req);
    const result = await route(deps, method, path, url, body);
    json(res, 200, result ?? null);
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    log.warn('request failed', { method, path, err: String(err) });
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- routes ----------------------------------------------------------------

async function route(
  deps: AgentDeps,
  method: string,
  path: string,
  url: URL,
  body: unknown,
): Promise<unknown> {
  if (method === 'GET' && path === '/agent/health') {
    const health: AgentHealth = {
      ok: true,
      runtimes: [
        {
          id: RUNTIME_HARNESS_ID,
          label: 'Companion',
          version: null,
          state: deps.runtime.state.ready ? 'ready' : 'unavailable',
          detail: deps.runtime.state.detail,
          needsModel: deps.runtime.state.needsModel,
        },
        {
          id: 'moxxy',
          label: 'Moxxy',
          version: deps.moxxy?.version ?? null,
          state: deps.moxxy?.compatible ? 'ready' : 'unavailable',
          detail: deps.moxxy
            ? deps.moxxy.compatible
              ? null
              : `Version ${deps.moxxy.version} is older than ${MIN_MOXXY_VERSION}`
            : 'Runtime executable not found',
        },
      ],
      liveRuns: deps.pool.liveCount + deps.runtime.liveCount,
      maxRuns: deps.maxRuns,
      protocol: RUNNER_AGENT_PROTOCOL,
    };
    return health;
  }

  const run = path.match(/^\/agent\/runs\/([^/]+)\/(spawn|stop|prompt|command|history|session-info)$/);
  if (run) {
    const runId = decodeURIComponent(run[1] ?? '');
    return routeRun(deps, method, run[2] ?? '', runId, url, body);
  }

  if (method === 'POST' && path === '/agent/scratch') {
    const { runId } = body as AgentScratchRequest;
    requireString(runId, 'runId');
    const cwd = join(paths.scratch(), safeId(runId));
    mkdirSync(cwd, { recursive: true });
    return { cwd } satisfies AgentScratchResponse;
  }

  if (method === 'POST' && path === '/agent/verify') {
    const { cwd, command, timeoutMs } = body as AgentVerifyRequest;
    requireString(cwd, 'cwd');
    requireString(command, 'command');
    // The worktree must be one this agent manages. A cwd from anywhere else would
    // turn "verify" into "run this on my machine", which is not what it is.
    if (!deps.checkouts.isManagedPath(cwd)) throw new HttpError(400, 'cwd is not a managed worktree');
    return (await runVerify(cwd, command, typeof timeoutMs === 'number' ? timeoutMs : undefined)) satisfies AgentVerifyResponse;
  }

  if (method === 'POST' && path === '/agent/storage/cleanup') {
    const request = storageCleanupRequest(body);
    return (await cleanupRunnerStorage(
      request,
      deps.checkouts,
      deps.pool.liveIds(),
    )) satisfies AgentStorageCleanupResponse;
  }

  if (method === 'POST' && path === '/agent/files/write') {
    const { cwd, path: relPath, content, mode } = body as AgentWriteFileRequest;
    requireString(cwd, 'cwd');
    requireString(relPath, 'path');
    requireString(content, 'content');
    // Only inside dirs the agent manages, and no traversal out of `cwd`.
    const roots = [paths.scratch(), paths.worktrees()].map((r) => resolve(r));
    const base = resolve(cwd);
    if (!roots.some((root) => base === root || base.startsWith(root + sep))) {
      throw new HttpError(403, 'cwd is outside the agent working area');
    }
    const target = resolve(base, relPath);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new HttpError(403, 'path escapes the working dir');
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: typeof mode === 'number' ? mode : 0o600 });
    return { ok: true };
  }

  if (method === 'POST' && path.startsWith('/agent/git/')) {
    return routeGit(deps.checkouts, path.slice('/agent/git/'.length), body);
  }

  throw new HttpError(404, `no route: ${method} ${path}`);
}

async function routeRun(
  deps: AgentDeps,
  method: string,
  action: string,
  runId: string,
  url: URL,
  body: unknown,
): Promise<unknown> {
  switch (action) {
    case 'spawn': {
      requireMethod(method, 'POST', action);
      const { cwd, sessionId, access, harness, spec, limits, mcpServers, verifyCommand, resultSchema, attended } =
        body as AgentSpawnRequest;
      requireString(cwd, 'cwd');
      requireString(sessionId, 'sessionId');
      if (access !== 'read-only' && access !== 'workspace-write' && access !== 'trusted-assistant') {
        throw new HttpError(400, 'access must be read-only, workspace-write, or trusted-assistant');
      }
      // Protocol 7: the run says which runtime it was recorded under. An older
      // daemon sends nothing and gets what this agent always ran.
      if (harness === RUNTIME_HARNESS_ID) {
        mkdirSync(cwd, { recursive: true });
        if (deps.pool.liveCount + deps.runtime.liveCount >= deps.maxRuns) {
          throw new HttpError(429, `this machine is running ${deps.maxRuns} agents already`);
        }
        try {
          await deps.runtime.spawn({
            runId,
            cwd,
            access,
            spec,
            limits,
            mcpServers,
            ...(verifyCommand ? { verifyCommand } : {}),
            ...(resultSchema !== undefined ? { resultSchema } : {}),
            ...(attended === true ? { attended: true } : {}),
          });
        } catch (err) {
          throw new HttpError(503, err instanceof Error ? err.message : String(err));
        }
        return { ok: true };
      }
      if (!deps.moxxy) throw new HttpError(503, 'moxxy CLI is not installed on this runner');
      // The pool pins MOXXY_SESSION_ID to the run id (sticky resume + history
      // file named after the run); companiond always sends sessionId === runId.
      if (sessionId !== runId) {
        log.warn('spawn sessionId differs from runId — using runId as the session id', { runId, sessionId });
      }
      mkdirSync(cwd, { recursive: true });
      await deps.pool.spawn({ runId, cwd, moxxyCliPath: deps.moxxy.path, access });
      return { ok: true };
    }
    case 'stop': {
      requireMethod(method, 'POST', action);
      if (deps.runtime.has(runId)) {
        await deps.runtime.stop(runId);
        return { ok: true };
      }
      await deps.pool.get(runId)?.stop();
      return { ok: true };
    }
    case 'prompt': {
      requireMethod(method, 'POST', action);
      const { prompt, model, attachments } = body as AgentPromptRequest;
      requireString(prompt, 'prompt');
      const session = deps.runtime.get(runId);
      if (session) return session.runTurn({ prompt, ...(model === undefined ? {} : { model }), attachments });
      return liveClient(deps.pool, runId).runTurn({ prompt, ...(model === undefined ? {} : { model }), attachments });
    }
    case 'command': {
      requireMethod(method, 'POST', action);
      const session = deps.runtime.get(runId);
      if (session) return runtimeCommand(session, body);
      return runCommand(deps.pool, runId, body);
    }
    case 'history': {
      requireMethod(method, 'GET', action);
      const limit = clampInt(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw === null || beforeRaw === '' ? null : clampInt(beforeRaw, 0, Number.MAX_SAFE_INTEGER);
      if (deps.runtime.has(runId) || deps.runtime.get(runId) !== null) {
        return deps.runtime.history(runId, before, limit);
      }
      const handle = deps.pool.get(runId);
      return loadHistoryWithFallback(
        handle?.client.isOpen ? () => handle.client.loadHistory(runId, before, limit) : null,
        runId,
        before,
        limit,
      );
    }
    case 'session-info': {
      requireMethod(method, 'GET', action);
      const session = deps.runtime.get(runId);
      if (session) return { info: await session.sessionInfo() } satisfies AgentSessionInfoResponse;
      return { info: await liveClient(deps.pool, runId).sessionInfo() } satisfies AgentSessionInfoResponse;
    }
    default:
      throw new HttpError(404, `no run action: ${action}`);
  }
}

/**
 * The subset of the command surface a built-in-runtime session answers. Its
 * capabilities declare no session controls, so a daemon that asks for one
 * skipped the check rather than meeting a harness that fell short.
 */
async function runtimeCommand(session: Harness, body: unknown): Promise<unknown> {
  const { command } = (body ?? {}) as AgentCommandRequest;
  if (!command || typeof command !== 'object' || typeof command.kind !== 'string') {
    throw badRequest('missing command');
  }
  if (command.kind === 'abortTurn') {
    await session.abortTurn(command.turnId);
    return { ok: true };
  }
  if (command.kind === 'respondAsk') {
    requireString(command.requestId, 'requestId');
    if (!command.response || typeof command.response !== 'object') throw badRequest('missing response');
    await session.respondAsk(command.requestId, command.response);
    return { ok: true };
  }
  throw badRequest(`the built-in runtime has no ${command.kind}`);
}

/** Dispatch the misc typed gateway commands onto the run's live GatewayClient. */
async function runCommand(pool: GatewayPool, runId: string, body: unknown): Promise<unknown> {
  const { command } = (body ?? {}) as AgentCommandRequest;
  if (!command || typeof command !== 'object' || typeof command.kind !== 'string') {
    throw badRequest('missing command');
  }
  const client = liveClient(pool, runId);
  switch (command.kind) {
    case 'abortTurn':
      await client.abortTurn(command.turnId);
      return { ok: true };
    case 'setMode':
      await client.setMode(requireString(command.mode, 'mode'));
      return { ok: true };
    case 'setModel':
      await client.setModel(command.model ?? null);
      return { ok: true };
    case 'setProvider':
      await client.setProvider(requireString(command.provider, 'provider'));
      return { ok: true };
    case 'setAutoApprove':
      await client.setAutoApprove(command.enabled === true);
      return { ok: true };
    case 'runCommand':
      // The command's own result IS the response body (companiond passes it through).
      return (await client.runCommand(requireString(command.name, 'name'), command.args)) ?? null;
    case 'respondAsk': {
      requireString(command.requestId, 'requestId');
      if (!command.response || typeof command.response !== 'object') throw badRequest('missing response');
      await client.respondAsk(command.requestId, command.response);
      return { ok: true };
    }
    default:
      throw badRequest(`unknown command kind: ${(command as { kind: string }).kind}`);
  }
}

async function routeGit(checkouts: Checkouts, action: string, body: unknown): Promise<unknown> {
  switch (action) {
    case 'clone-status': {
      const { repo } = body as AgentCloneStatusRequest;
      requireString(repo, 'repo');
      return {
        hasClone: checkouts.hasClone(repo),
        cloneDir: checkouts.cloneDir(repo),
      } satisfies AgentCloneStatusResponse;
    }
    case 'ensure-clone': {
      const { repo, githubToken } = body as AgentEnsureCloneRequest;
      requireString(repo, 'repo');
      await checkouts.clone(repo, githubToken);
      return { ok: true };
    }
    case 'fetch': {
      const { repo, githubToken } = body as AgentFetchRequest;
      requireString(repo, 'repo');
      await checkouts.fetch(repo, githubToken);
      return { ok: true };
    }
    case 'worktree': {
      const { repo, key, branch, baseBranch, githubToken } = body as AgentWorktreeRequest;
      requireString(repo, 'repo');
      requireString(key, 'key');
      requireString(branch, 'branch');
      requireString(baseBranch, 'baseBranch');
      const cwd = await checkouts.addWorktree(repo, key, branch, baseBranch, githubToken);
      return { cwd } satisfies AgentWorktreeResponse;
    }
    case 'worktree-at': {
      const { repo, key, branch, githubToken } = body as AgentWorktreeAtRequest;
      requireString(repo, 'repo');
      requireString(key, 'key');
      requireString(branch, 'branch');
      const cwd = await checkouts.addWorktreeAtBranch(repo, key, branch, githubToken);
      return { cwd } satisfies AgentWorktreeResponse;
    }
    case 'remove-worktree': {
      const { repo, cwd } = body as AgentRemoveWorktreeRequest;
      requireString(repo, 'repo');
      requireString(cwd, 'cwd');
      await checkouts.removeWorktree(repo, cwd);
      return { ok: true };
    }
    case 'diff': {
      const { cwd, baseBranch } = body as AgentDiffRequest;
      requireString(cwd, 'cwd');
      requireString(baseBranch, 'baseBranch');
      return { diff: await checkouts.diffVsBase(cwd, baseBranch) } satisfies AgentDiffResponse;
    }
    case 'commit-all': {
      const { cwd, message, author, baseBranch } = body as AgentCommitRequest;
      requireString(cwd, 'cwd');
      requireString(message, 'message');
      if (author) {
        requireString(author.name, 'author.name');
        requireString(author.email, 'author.email');
      }
      if (baseBranch !== undefined) requireString(baseBranch, 'baseBranch');
      await checkouts.commitAll(cwd, message, author, baseBranch);
      return { ok: true };
    }
    case 'push': {
      const { repo, cwd, branch, githubToken } = body as AgentPushRequest;
      requireString(repo, 'repo');
      requireString(cwd, 'cwd');
      requireString(branch, 'branch');
      await checkouts.push(repo, cwd, branch, githubToken);
      return { ok: true };
    }
    default:
      throw new HttpError(404, `no git action: ${action}`);
  }
}

// ---------- helpers ---------------------------------------------------------------

function liveClient(pool: GatewayPool, runId: string): GatewayClient {
  const handle = pool.get(runId);
  if (!handle || !handle.client.isOpen) {
    throw new HttpError(409, `run ${runId} has no live gateway (spawn it first)`);
  }
  return handle.client;
}

function requireMethod(method: string, expected: string, action: string): void {
  if (method !== expected) throw new HttpError(405, `method ${method} not allowed on ${action}`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw badRequest(`missing ${name}`);
  return value;
}

function storageCleanupRequest(value: unknown): AgentStorageCleanupRequest {
  if (!value || typeof value !== 'object') throw badRequest('invalid storage cleanup request');
  const raw = value as Record<string, unknown>;
  const duration = (key: string): number => {
    const candidate = raw[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
      throw badRequest(`${key} must be a positive number`);
    }
    return candidate;
  };
  if (!Array.isArray(raw.runs) || raw.runs.length > 10_000) throw badRequest('runs must be a bounded array');
  const runs = raw.runs.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw badRequest(`runs[${index}] is invalid`);
    const run = candidate as Record<string, unknown>;
    if (typeof run.runId !== 'string' || !run.runId.trim()) throw badRequest(`runs[${index}].runId is invalid`);
    if (typeof run.cwd !== 'string') throw badRequest(`runs[${index}].cwd is invalid`);
    if (typeof run.updatedAt !== 'number' || !Number.isFinite(run.updatedAt)) {
      throw badRequest(`runs[${index}].updatedAt is invalid`);
    }
    if (typeof run.protected !== 'boolean') throw badRequest(`runs[${index}].protected is invalid`);
    return { runId: run.runId, cwd: run.cwd, updatedAt: run.updatedAt, protected: run.protected };
  });
  return {
    worktreeRetentionMs: duration('worktreeRetentionMs'),
    scratchRetentionMs: duration('scratchRetentionMs'),
    sessionRetentionMs: duration('sessionRetentionMs'),
    runs,
  };
}

function clampInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`invalid number: ${raw}`);
  return Math.min(n, max);
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return null;
}

/** Constant-time token comparison (hash first so lengths always match). */
function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
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
