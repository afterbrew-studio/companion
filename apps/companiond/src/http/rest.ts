import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { MoxxyStatus, SessionBootstrap } from '@companion/contract';
import type { DaemonConfig } from '../config.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Fixes } from '../runs/fixes.js';
import type { MoxxyCli } from '../moxxy/cli.js';
import { homeStatus, importProvidersFromDailyMoxxy } from '../moxxy/home.js';
import type { Store } from '../store/db.js';
import { rowToRepo } from '../store/db.js';
import type { GitHubClient } from '../github/client.js';
import type { GitHubSync } from '../github/sync.js';
import type { Checkouts } from '../git/checkouts.js';
import type { Triage } from '../triage/triage.js';
import type { PrReviews } from '../prs/reviews.js';
import type { Proposals } from '../proposals/proposals.js';
import type { Automations } from '../automations/automations.js';
import type { Skills } from '../skills/skills.js';
import { log } from '../log.js';

const promptSchema = z.object({ prompt: z.string().min(1), model: z.string().optional() });
const createRunSchema = z.object({
  kind: z.enum(['interactive', 'triage', 'fix', 'analysis', 'implement', 'report']).optional(),
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
const ghTokenSchema = z.object({ token: z.string().min(10) });
const addRepoSchema = z.object({ fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/) });
const automationSchema = z.object({
  autoTriage: z.boolean().optional(),
  digest: z.boolean().optional(),
  staleSweep: z.boolean().optional(),
  prGate: z.boolean().optional(),
});
const mergeSchema = z.object({ method: z.enum(['merge', 'squash', 'rebase']).default('squash') });
const applyTriageSchema = z.object({ comment: z.boolean().default(true) });
const approvePrSchema = z.object({ title: z.string().optional(), body: z.string().optional() });
const proposalSchema = z.object({
  repo: z.string(),
  title: z.string().min(3).max(200),
  body: z.string().min(1),
});
const skillSchema = z.object({ content: z.string().max(64_000) });

export interface RestDeps {
  readonly config: DaemonConfig;
  readonly orchestrator: Orchestrator;
  readonly moxxyCli: MoxxyCli | null;
  readonly store: Store;
  readonly github: () => GitHubClient | null;
  readonly githubUser: () => string | null;
  readonly setGithubToken: (token: string) => Promise<{ login: string }>;
  readonly sync: GitHubSync;
  readonly checkouts: Checkouts;
  readonly triage: Triage;
  readonly prReviews: PrReviews;
  readonly fixes: Fixes;
  readonly proposals: Proposals;
  readonly automations: Automations;
  readonly skills: Skills;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;

  try {
    if (method === 'GET' && path === '/api/session') {
      const body: SessionBootstrap = { token: deps.config.spaToken, version: '0.2.0' };
      return json(res, 200, body);
    }

    if (!authorized(req, url, deps.config.spaToken)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    // ---------- status / setup -------------------------------------------------

    if (method === 'GET' && path === '/api/status') {
      const home = homeStatus();
      const body: MoxxyStatus = {
        cliPath: deps.moxxyCli?.path ?? null,
        cliVersion: deps.moxxyCli?.version ?? null,
        compatible: deps.moxxyCli?.compatible ?? false,
        homeDir: home.homeDir,
        homeReady: home.homeReady,
        providersImported: home.providersImported,
        githubConfigured: deps.github() !== null,
        githubUser: deps.githubUser(),
      };
      return json(res, 200, body);
    }

    if (method === 'POST' && path === '/api/moxxy/import-providers') {
      const body = importSchema.parse(await readBody(req));
      return json(res, 200, importProvidersFromDailyMoxxy(body.sourceHome));
    }

    if (method === 'POST' && path === '/api/settings/github') {
      const body = ghTokenSchema.parse(await readBody(req));
      const viewer = await deps.setGithubToken(body.token);
      return json(res, 200, { login: viewer.login });
    }

    // ---------- repos ------------------------------------------------------------

    if (method === 'GET' && path === '/api/repos') {
      const repos = deps.store.listRepos().map((row) => ({
        ...rowToRepo(row),
        openIssues: deps.store.listIssues(row.full_name, 'open').length,
      }));
      return json(res, 200, { repos });
    }

    if (method === 'POST' && path === '/api/repos') {
      const body = addRepoSchema.parse(await readBody(req));
      const client = deps.github();
      if (!client) return json(res, 400, { error: 'GitHub is not configured (set a PAT first)' });
      const meta = await client.repo(body.fullName);
      deps.store.upsertRepo({
        fullName: meta.full_name,
        owner: meta.owner.login,
        name: meta.name,
        defaultBranch: meta.default_branch,
        private: meta.private,
      });
      // Clone + first sync in the background; the UI follows repos.changed.
      void (async () => {
        try {
          await deps.checkouts.clone(meta.full_name);
          deps.store.setRepoCloneReady(meta.full_name, true);
          await deps.sync.syncRepo(meta.full_name);
        } catch (err) {
          log.warn('repo provisioning failed', { repo: meta.full_name, err: String(err) });
        }
      })();
      return json(res, 201, { repo: rowToRepo(deps.store.getRepo(meta.full_name)!) });
    }

    const repoMatch = path.match(/^\/api\/repos\/([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
    if (repoMatch) {
      const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
      const rest = repoMatch[3] ?? '';
      const repoRow = deps.store.getRepo(fullName);
      if (!repoRow) return json(res, 404, { error: `repo ${fullName} not connected` });

      if (method === 'DELETE' && !rest) {
        deps.store.removeRepo(fullName);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && rest === 'sync') {
        const result = await deps.sync.syncRepo(fullName);
        return json(res, 200, result);
      }
      if (method === 'POST' && rest === 'automation') {
        const body = automationSchema.parse(await readBody(req));
        if (body.autoTriage !== undefined) deps.store.setRepoAutomation(fullName, 'auto_triage', body.autoTriage);
        if (body.digest !== undefined) deps.store.setRepoAutomation(fullName, 'digest_enabled', body.digest);
        if (body.staleSweep !== undefined) deps.store.setRepoAutomation(fullName, 'stale_enabled', body.staleSweep);
        if (body.prGate !== undefined) deps.store.setRepoAutomation(fullName, 'pr_gate', body.prGate);
        return json(res, 200, { repo: rowToRepo(deps.store.getRepo(fullName)!) });
      }
      if (method === 'POST' && rest === 'webhook') {
        return json(res, 200, deps.automations.ensureWebhook(fullName));
      }
      if (method === 'POST' && rest === 'digest-now') {
        await deps.automations.runDigest(fullName);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && rest === 'stale-now') {
        deps.automations.runStaleSweep(fullName);
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && rest === 'issues') {
        const state = url.searchParams.get('state');
        return json(res, 200, {
          issues: deps.store.listIssues(fullName, state === 'open' || state === 'closed' ? state : undefined),
        });
      }
      if (method === 'GET' && rest === 'prs') {
        return json(res, 200, { prs: deps.store.listPrs(fullName) });
      }
      if (method === 'GET' && rest === 'triage') {
        return json(res, 200, { results: deps.store.listTriage(fullName) });
      }

      const prMatch = rest.match(/^prs\/(\d+)(?:\/([a-z-]+))?$/);
      if (prMatch) {
        const number = Number(prMatch[1]);
        const action = prMatch[2];
        if (method === 'GET' && !action) {
          const pr = deps.store.getPr(fullName, number);
          if (!pr) return json(res, 404, { error: 'PR not found' });
          return json(res, 200, { pr, review: deps.store.latestPrReview(fullName, number) ?? null });
        }
        if (method === 'POST' && action === 'analyze') {
          void deps.prReviews
            .analyzePr(fullName, number)
            .catch((err) => log.warn('pr analysis failed', { fullName, number, err: String(err) }));
          return json(res, 202, { queued: true });
        }
        if (method === 'POST' && action === 'merge') {
          const body = mergeSchema.parse(await readBody(req).catch(() => ({})));
          await deps.prReviews.merge(fullName, number, body.method);
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && action === 'close') {
          await deps.prReviews.close(fullName, number);
          return json(res, 200, { ok: true });
        }
      }

      const issueMatch = rest.match(/^issues\/(\d+)(?:\/([a-z-]+))?$/);
      if (issueMatch) {
        const number = Number(issueMatch[1]);
        const action = issueMatch[2];
        if (method === 'GET' && !action) {
          const issue = deps.store.getIssue(fullName, number);
          if (!issue) return json(res, 404, { error: 'issue not found' });
          return json(res, 200, { issue, triage: deps.store.latestTriage(fullName, number) ?? null });
        }
        if (method === 'POST' && action === 'triage') {
          // Long-running; kick it and let the UI follow triage.changed.
          void deps.triage
            .triageIssue(fullName, number)
            .catch((err) => log.warn('triage failed', { fullName, number, err: String(err) }));
          return json(res, 202, { queued: true });
        }
        if (method === 'POST' && action === 'fix') {
          const run = await deps.fixes.startFix(fullName, number);
          return json(res, 201, { run });
        }
      }
    }

    // ---------- triage results ------------------------------------------------------

    const triageMatch = path.match(/^\/api\/triage\/([\w-]+)\/(apply|dismiss)$/);
    if (triageMatch && method === 'POST') {
      const id = triageMatch[1]!;
      if (triageMatch[2] === 'apply') {
        const body = applyTriageSchema.parse(await readBody(req).catch(() => ({})));
        await deps.triage.apply(id, { comment: body.comment });
      } else {
        deps.triage.dismiss(id);
      }
      return json(res, 200, { ok: true });
    }

    const prReviewMatch = path.match(/^\/api\/pr-reviews\/([\w-]+)\/(apply|dismiss)$/);
    if (prReviewMatch && method === 'POST') {
      const id = prReviewMatch[1]!;
      if (prReviewMatch[2] === 'apply') await deps.prReviews.apply(id);
      else deps.prReviews.dismiss(id);
      return json(res, 200, { ok: true });
    }

    // ---------- proposals --------------------------------------------------------------

    if (method === 'GET' && path === '/api/proposals') {
      return json(res, 200, { proposals: deps.store.listProposals() });
    }
    if (method === 'POST' && path === '/api/proposals') {
      const body = proposalSchema.parse(await readBody(req));
      if (!deps.store.getRepo(body.repo)) return json(res, 400, { error: `repo ${body.repo} not connected` });
      return json(res, 201, { proposal: deps.proposals.create(body.repo, body.title, body.body) });
    }
    const proposalMatch = path.match(/^\/api\/proposals\/([\w-]+)\/(analyze|approve|finish|reject)$/);
    if (proposalMatch && method === 'POST') {
      const id = proposalMatch[1]!;
      switch (proposalMatch[2]) {
        case 'analyze':
          void deps.proposals.analyze(id).catch((err) => log.warn('analysis failed', { id, err: String(err) }));
          return json(res, 202, { queued: true });
        case 'approve':
          return json(res, 200, { proposal: await deps.proposals.approve(id) });
        case 'finish':
          return json(res, 200, { proposal: await deps.proposals.finishImplementation(id) });
        case 'reject':
          deps.proposals.reject(id);
          return json(res, 200, { ok: true });
      }
    }

    // ---------- reports ------------------------------------------------------------------

    if (method === 'GET' && path === '/api/reports') {
      return json(res, 200, { reports: deps.store.listReports() });
    }

    // ---------- skills --------------------------------------------------------------------

    if (path === '/api/skills' && method === 'GET') {
      return json(res, 200, { skills: deps.skills.list() });
    }
    const skillMatch = path.match(/^\/api\/skills\/([a-z0-9-]+)$/);
    if (skillMatch) {
      const name = skillMatch[1]!;
      if (method === 'GET') {
        const skill = deps.skills.get(name);
        return skill ? json(res, 200, { skill }) : json(res, 404, { error: 'not found' });
      }
      if (method === 'PUT') {
        const body = skillSchema.parse(await readBody(req));
        return json(res, 200, { skill: deps.skills.save(name, body.content) });
      }
      if (method === 'DELETE') {
        deps.skills.remove(name);
        return json(res, 200, { ok: true });
      }
    }

    // ---------- runs -----------------------------------------------------------------------

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
      if (method === 'GET' && action === 'diff') {
        return json(res, 200, await deps.fixes.diff(runId));
      }
      if (method === 'POST' && action === 'approve-pr') {
        const body = approvePrSchema.parse(await readBody(req).catch(() => ({})));
        return json(res, 200, await deps.fixes.approve(runId, body));
      }
      if (method === 'POST' && action === 'discard') {
        await deps.fixes.discard(runId);
        return json(res, 200, { ok: true });
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

export async function readBody(req: IncomingMessage): Promise<unknown> {
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

/** Raw-body reader for webhook HMAC verification (bytes must be exact). */
export async function readRawBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
