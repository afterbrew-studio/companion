import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { MoxxyStatus, SessionBootstrap } from '@companion/contract';
import type { DaemonConfig } from '../config.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { MoxxyCli } from '../moxxy/cli.js';
import { homeStatus, importProvidersFromDailyMoxxy } from '../moxxy/home.js';

/**
 * REST surface for the SPA. All routes require the SPA bearer token except
 * `GET /api/session`, which IS the token bootstrap (loopback bind = the trust
 * boundary, mirroring moxxy's stance for local bridges).
 */

const promptSchema = z.object({ prompt: z.string().min(1), model: z.string().optional() });
const createRunSchema = z.object({
  kind: z.enum(['interactive', 'triage', 'fix', 'analysis']).optional(),
  title: z.string().max(200).optional(),
});
const askRespondSchema = z.object({
  requestId: z.string(),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().optional(),
    text: z.string().optional(),
  }),
});
const abortSchema = z.object({ turnId: z.string().optional() });
const importSchema = z.object({ sourceHome: z.string().optional() });

export interface RestDeps {
  readonly config: DaemonConfig;
  readonly orchestrator: Orchestrator;
  readonly moxxyCli: MoxxyCli | null;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RestDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;

  try {
    // Token bootstrap — the only unauthenticated route.
    if (method === 'GET' && path === '/api/session') {
      const body: SessionBootstrap = { token: deps.config.spaToken, version: '0.1.0' };
      return json(res, 200, body);
    }

    if (!authorized(req, url, deps.config.spaToken)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    if (method === 'GET' && path === '/api/status') {
      const home = homeStatus();
      const body: MoxxyStatus = {
        cliPath: deps.moxxyCli?.path ?? null,
        cliVersion: deps.moxxyCli?.version ?? null,
        compatible: deps.moxxyCli?.compatible ?? false,
        homeDir: home.homeDir,
        homeReady: home.homeReady,
        providersImported: home.providersImported,
      };
      return json(res, 200, body);
    }

    if (method === 'POST' && path === '/api/moxxy/import-providers') {
      const body = importSchema.parse(await readBody(req));
      return json(res, 200, importProvidersFromDailyMoxxy(body.sourceHome));
    }

    if (method === 'GET' && path === '/api/runs') {
      return json(res, 200, { runs: deps.orchestrator.listRuns() });
    }

    if (method === 'POST' && path === '/api/runs') {
      const body = createRunSchema.parse(await readBody(req));
      const run = await deps.orchestrator.createRun(body);
      return json(res, 201, { run });
    }

    const runMatch = path.match(/^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/);
    if (runMatch) {
      const runId = runMatch[1]!;
      const action = runMatch[2];

      if (method === 'GET' && !action) {
        const run = deps.orchestrator.getRun(runId);
        if (!run) return json(res, 404, { error: 'run not found' });
        return json(res, 200, { run, pendingAsks: deps.orchestrator.pendingAsksFor(runId) });
      }
      if (method === 'GET' && action === 'history') {
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? '200');
        const segment = await deps.orchestrator.loadHistory(
          runId,
          before === null ? null : Number(before),
          Math.min(Math.max(limit, 1), 500),
        );
        return json(res, 200, segment);
      }
      if (method === 'POST' && action === 'prompt') {
        const body = promptSchema.parse(await readBody(req));
        const result = await deps.orchestrator.sendPrompt(runId, body.prompt, body.model);
        return json(res, 200, result);
      }
      if (method === 'POST' && action === 'abort') {
        const body = abortSchema.parse(await readBody(req).catch(() => ({})));
        await deps.orchestrator.abortTurn(runId, body.turnId);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'ask') {
        const body = askRespondSchema.parse(await readBody(req));
        await deps.orchestrator.respondAsk(runId, body.requestId, body.response);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'resume') {
        const run = await deps.orchestrator.resumeRun(runId);
        return json(res, 200, { run });
      }
      if (method === 'POST' && action === 'stop') {
        await deps.orchestrator.stopRun(runId);
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return json(res, 400, { error: 'invalid request', issues: err.issues });
    }
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get('token') === token;
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
    if (size > 2 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
