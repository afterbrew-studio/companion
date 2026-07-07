import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AskRequest, AuthUser, HistorySegment, RunRecord } from '@companion/contract';
import { log } from '../log.js';
import { paths, type DaemonConfig } from '../config.js';
import type { Auth } from '../auth/auth.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';

/** Scoped API token lifetime; refreshed whenever the conversation (re)attaches. */
const TOKEN_TTL_MS = 12 * 60 * 60_000;

/** Idle gateway reaping: free the process (and pool slot) between exchanges. */
const IDLE_REAP_MS = 5 * 60_000;
/** …but a conversation parked on a pending ask gets a longer grace period. */
const IDLE_REAP_ASK_MS = 30 * 60_000;

/** The SPA folds the platform briefing out of the transcript above this marker. */
export const USER_MARKER = '<<<USER_MESSAGE>>>';

const CREDENTIALS_FILE = 'companion-credentials.json';

/**
 * AI Help: one persistent conversation run per user (kind 'assistant') that
 * knows the platform and ACTS on it — it drives the same REST API as the SPA
 * with a short-lived token carrying the user's own role, so RBAC holds no
 * matter what the model tries. The token lives in a file inside the run's cwd
 * (never in the prompt, so transcripts stay clean); the first prompt carries
 * a briefing on Companion's concepts and API cookbook.
 */
export class Assistant {
  /** Last user interaction per assistant run — feeds the idle reaper. */
  private readonly lastActivity = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly auth: Auth,
    private readonly config: DaemonConfig,
  ) {
    // The conversation survives reaping (moxxy sessions persist on disk);
    // the next message transparently resumes it. unref'd so shutdown is clean.
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  private mapKey(username: string): string {
    return `assistant:run:${username}`;
  }

  private touch(runId: string): void {
    this.lastActivity.set(runId, Date.now());
  }

  /** Stop gateways of assistant runs nobody has talked to in a while. */
  private reapIdle(): void {
    for (const run of this.orchestrator.listRuns()) {
      if (run.kind !== 'assistant' || !run.live) continue;
      // updatedAt moves with every provider response, so an active turn
      // never looks idle even without explicit touches.
      const lastSeen = Math.max(this.lastActivity.get(run.id) ?? 0, run.updatedAt);
      const limit = this.orchestrator.pendingAsksFor(run.id).length > 0 ? IDLE_REAP_ASK_MS : IDLE_REAP_MS;
      if (Date.now() - lastSeen > limit) {
        log.info('reaping idle assistant gateway', { runId: run.id });
        void this.orchestrator.stopRun(run.id).catch(() => undefined);
      }
    }
  }

  private currentRun(username: string): RunRecord | null {
    const runId = this.store.settings.get(this.mapKey(username));
    return runId ? this.orchestrator.getRun(runId) : null;
  }

  info(user: AuthUser): { run: RunRecord | null; pendingAsks: AskRequest[] } {
    const run = this.currentRun(user.username);
    return { run, pendingAsks: run ? this.orchestrator.pendingAsksFor(run.id) : [] };
  }

  /** Attach to the user's conversation: resume the mapped run or start fresh. */
  async ensureRun(user: AuthUser): Promise<RunRecord> {
    const existing = this.currentRun(user.username);
    if (existing && existing.status !== 'failed' && existing.status !== 'abandoned') {
      if (existing.live) {
        this.touch(existing.id);
        return existing;
      }
      try {
        const resumed = await this.orchestrator.resumeRun(existing.id);
        this.writeCredentials(resumed.cwd, user.username);
        this.touch(resumed.id);
        return resumed;
      } catch (err) {
        log.warn('assistant resume failed — starting a new conversation', {
          username: user.username,
          err: String(err),
        });
      }
    }

    const safe = user.username.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cwd = join(paths.scratch(), 'assistant', safe);
    mkdirSync(cwd, { recursive: true });
    this.writeCredentials(cwd, user.username);
    const run = await this.orchestrator.createRun({
      kind: 'assistant',
      title: `AI Help — ${user.displayName || user.username}`,
      cwd,
    });
    this.store.settings.set(this.mapKey(user.username), run.id);
    this.store.settings.set(`assistant:primed:${run.id}`, '0');
    this.touch(run.id);
    return run;
  }

  /**
   * Send a user message; the first one of a conversation carries the platform
   * briefing, and a repo scope (the panel's selector) rides along hidden —
   * everything before USER_MARKER is folded out of the visible transcript.
   */
  async send(user: AuthUser, text: string, repo?: string): Promise<{ turnId: string }> {
    const run = await this.ensureRun(user);
    const primedKey = `assistant:primed:${run.id}`;
    const primed = this.store.settings.get(primedKey) === '1';
    const scope =
      repo && this.store.repos.get(repo)
        ? `(The user is currently focused on the repository ${repo} — scope reads and actions there unless they say otherwise.)\n`
        : '';
    const hidden = `${primed ? '' : `${this.briefing(user)}\n\n`}${scope}`;
    const prompt = hidden ? `${hidden}${USER_MARKER}\n${text}` : text;
    const result = await this.orchestrator.sendPrompt(run.id, prompt);
    if (!primed) this.store.settings.set(primedKey, '1');
    this.touch(run.id);
    return result;
  }

  async history(user: AuthUser, before: number | null, limit: number): Promise<HistorySegment> {
    const run = this.currentRun(user.username);
    if (!run) return { events: [], prevCursor: null };
    return this.orchestrator.loadHistory(run.id, before, limit);
  }

  async respondAsk(
    user: AuthUser,
    requestId: string,
    response: { mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny'; optionId?: string; text?: string },
  ): Promise<void> {
    const run = this.requireRun(user);
    await this.orchestrator.respondAsk(run.id, requestId, response);
    this.touch(run.id);
  }

  async abort(user: AuthUser): Promise<void> {
    const run = this.requireRun(user);
    await this.orchestrator.abortTurn(run.id);
  }

  /** New conversation: stop the old run (it stays in Agent Runs) and unmap it. */
  async reset(user: AuthUser): Promise<void> {
    const run = this.currentRun(user.username);
    if (run) await this.orchestrator.stopRun(run.id).catch(() => undefined);
    this.store.settings.set(this.mapKey(user.username), '');
  }

  private requireRun(user: AuthUser): RunRecord {
    const run = this.currentRun(user.username);
    if (!run) throw new Error('no assistant conversation yet');
    return run;
  }

  /**
   * Fresh scoped token into the run's cwd. Role checks happen server-side on
   * every request, so a stale file can never out-privilege the user.
   */
  private writeCredentials(cwd: string, username: string): void {
    const session = this.auth.mintSession(username, TOKEN_TTL_MS);
    writeFileSync(
      join(cwd, CREDENTIALS_FILE),
      JSON.stringify(
        { baseUrl: `http://127.0.0.1:${this.config.port}`, token: session.token, expiresAt: session.expiresAt },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  /** The tailored platform knowledge + API cookbook the agent starts from. */
  private briefing(user: AuthUser): string {
    const workspaces = this.store.workspaces.list().map((ws) => {
      const repos = this.store.repos
        .listByWorkspace(ws.id)
        .map((r) => r.full_name)
        .join(', ');
      return `- ${ws.name} (id: ${ws.id})${repos ? ` — repos: ${repos}` : ' — no repos yet'}`;
    });

    return `You are AI Help, the built-in operator of THIS Companion install. Companion is a self-hosted engineering dashboard that manages GitHub repositories end-to-end with autonomous agents: it triages issues, reviews pull requests with CI context, runs PR pipelines, and turns proposals and specifications into implemented PRs.

You perform PLATFORM OPERATIONS on behalf of ${user.displayName || user.username} (role: ${user.role}) — run a pipeline on a PR, find an issue by title, file a proposal, kick off triage, search the docs index. Your entire tool surface is Companion's REST API; you are not a general-purpose shell agent.

## How to call the API
Read ./${CREDENTIALS_FILE} (JSON: baseUrl, token). For every call:
  curl -s -H "Authorization: Bearer $TOKEN" "$BASEURL/api/..."
POST/PATCH bodies are JSON (add -H "content-type: application/json"). Responses are JSON. A 403 means the user's role does not allow that action — say so instead of retrying. NEVER print or echo the token.

## Platform model
- A workspace groups repositories. Everything (proposals, specs, docs, issues, PRs, pipelines) is scoped to a workspace or its repos.
- Roles: admin (everything), maintainer (day-to-day work), business (proposals + read-only specs/docs).
- Proposal lifecycle: draft → analyzing → analyzed → approved/implementing → review → implemented (PR opened). Analysis is a read-only agent studying the repo; implementation is a goal-mode agent in a worktree whose diff a human reviews.
- Specifications: repo-grounded markdown specs. "Create feature" turns a spec into a proposal carrying the spec.
- Documentation: workspace knowledge chunked into a retrieval index — search it BEFORE answering domain questions about the user's project or business.
- Pipelines: typed step sequences (CI gate, AI review, custom agent, label, comment) run against PRs/issues/repos.
- Agent runs: every agent session is a run (this conversation is one too).
- The web app: modules in the left sidebar; press g + a key to jump (g o Overview, g w Reviews, g p Proposals, g c Specifications, g d Documentation, g i Issues, g r Pull Requests, g l Pipelines, g a Agent Runs); Cmd/Ctrl+K is global search; ? shows all shortcuts. Link the user to places with hash links like #/proposals or #/runs/<id>.

## This install right now
${workspaces.join('\n') || '- no workspaces yet'}

## API cookbook (the ones you need most)
Reading:
- GET /api/workspaces · GET /api/workspaces/:id/repos · /issues?state=open&q= · /prs?state=open · /proposals · /specs · /docs · /reviews (everything awaiting a human) · /metrics · /pipelines · /pipeline-runs
- GET /api/workspaces/:id/docs/search?q=<query> — retrieval over the knowledge index
- GET /api/repos/:owner/:name/issues/:n · GET /api/repos/:owner/:name/prs/:n · GET /api/runs · GET /api/notifications
Acting:
- POST /api/proposals {repo,title,body} · POST /api/proposals/:id/analyze · /approve · /finish · /reject
- POST /api/specs {repo,title,content} · POST /api/specs/generate {repo,instructions} (async — a drafting agent runs) · POST /api/specs/:id/create-feature {title?,notes?}
- POST /api/workspaces/:id/docs {repo?,title,content} · POST /api/workspaces/:id/docs/generate {repo?,instructions} (slow: an agent writes it)
- POST /api/repos/:owner/:name/issues/:n/triage · /fix (starts a fix agent) · /comment {body} · /state {state:"open"|"closed"}
- POST /api/repos/:owner/:name/prs/:n/analyze (AI review) · /comment {body} · /merge {method:"merge"|"squash"|"rebase"} · /close
- POST /api/repos/:owner/:name/prs/:n/pipelines/:pipelineId/run · POST /api/repos/:owner/:name/sync

## Rules
1. Platform operations ONLY. The single shell command you use is curl against $BASEURL (plus reading ./${CREDENTIALS_FILE} once). Never edit files, never run other tools, and decline requests outside operating Companion — say it is out of scope.
2. Ground yourself first: GET the current state before acting, and search the docs index for project/business questions.
3. Confirm with the user (in chat, before calling) anything destructive or outward-facing: merging/closing PRs, closing issues, rejecting proposals, deleting anything, posting comments to GitHub.
4. After acting, verify with a GET and report what changed, with a hash link to where the user can see it.
5. Multi-step requests: do all the steps, then summarize once.
6. Be concise. Markdown. No preamble about being an AI.`;
  }
}
