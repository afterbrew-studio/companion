import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SpaServerMessage } from '@moxxy/companion-sdk';
import type { BriefingCadence, WebhookInfo } from '@companion/module-code/contract';
import type { NotificationKind } from '@companion/module-workspace/contract';
import { log } from '@moxxy/companion-sdk/server';
import type { AutomationsStore } from './automations-store.js';
import type {
  Checkouts,
  GhIssue,
  GhPull,
  GitHubClient,
  GitHubSync,
  Orchestrator,
  Pipelines,
  PrChecks,
  PrReviews,
  Specs,
  Triage,
  WebhookTunnel,
} from './cross-types.js';

/**
 * Automations: a GitHub webhook receiver (HMAC-verified, raw body) and a slow
 * schedule ticker (daily digest, stale sweep, workspace briefings, the
 * auto-merge sweep). Rules are per-repo switches; user-defined pipelines with
 * auto-run also fire here on PR open.
 */
export class Automations {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: AutomationsStore,
    private readonly orchestrator: Orchestrator,
    private readonly triage: Triage,
    private readonly prReviews: PrReviews,
    private readonly prChecks: PrChecks,
    private readonly pipelines: Pipelines,
    private readonly sync: GitHubSync,
    private readonly checkouts: Checkouts,
    private readonly webhookTunnel: WebhookTunnel,
    private readonly specs: Specs,
    private readonly github: (repo: string, username: string) => GitHubClient | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  // ---------- webhooks -----------------------------------------------------------

  /** Enable the receiver for a repo: mint (or return) its HMAC secret. */
  ensureWebhook(repo: string, ownerId: string, accountId: string, accountLogin: string): WebhookInfo {
    const existing = this.store.repos.getWebhookRegistration(repo);
    if (existing?.ownerId && existing.ownerId !== ownerId) {
      throw new Error('this webhook is managed by another Companion profile');
    }
    const secret = existing?.secret ?? randomBytes(24).toString('hex');
    this.store.repos.setWebhookRegistration(repo, secret, ownerId, accountId);
    this.broadcast({ t: 'repos.changed' });
    return this.webhookInfo(repo, ownerId, accountLogin)!;
  }

  /** Disable the receiver for a repo: deliveries 401/404 until re-enabled. */
  disableWebhook(repo: string, ownerId: string): void {
    const registration = this.store.repos.getWebhookRegistration(repo);
    if (registration?.ownerId !== ownerId) throw new Error('only the webhook owner can disable it');
    this.store.repos.clearWebhookRegistration(repo);
    this.broadcast({ t: 'repos.changed' });
  }

  /** Current receiver info WITHOUT enabling — null while disabled. */
  webhookInfo(repo: string, viewerId: string, accountLogin: string | null): WebhookInfo | null {
    const registration = this.store.repos.getWebhookRegistration(repo);
    if (!registration) return null;
    const path = `/webhooks/github/${repo}`;
    const managedByYou = registration.ownerId === viewerId;
    return {
      path,
      secret: managedByYou ? registration.secret : null,
      url: this.webhookTunnel.deliveryUrl(path),
      ownerId: registration.ownerId,
      accountId: registration.accountId,
      accountLogin,
      managedByYou,
    };
  }

  /**
   * Handle a delivery. `rawBody` MUST be the exact bytes received — GitHub's
   * X-Hub-Signature-256 is HMAC-SHA256 over the raw payload.
   */
  handleDelivery(
    repo: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { status: number; body: string } {
    const registration = this.store.repos.getWebhookRegistration(repo);
    if (!registration) return { status: 404, body: 'webhook not configured for this repo' };
    const { secret, ownerId } = registration;

    const signature = String(headers['x-hub-signature-256'] ?? '');
    if (!verifySignature(secret, rawBody, signature)) {
      log.warn('webhook signature rejected', { repo });
      return { status: 401, body: 'bad signature' };
    }

    const eventName = String(headers['x-github-event'] ?? '');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { status: 400, body: 'invalid JSON' };
    }

    // The delivery carries the full changed object — apply it to the cache
    // right away. Automation below must never wait on (or race) the slower
    // REST sync: before this, triage fired against an issue that wasn't in
    // the store yet and died on "unknown issue".
    const action = String(payload.action ?? '');
    const repoRow = this.store.repos.get(repo);
    const automationOwnerId = repoRow?.automation_owner_id ?? null;
    if (eventName === 'issues') {
      const issue = payload.issue as GhIssue | undefined;
      if (issue?.number && !issue.pull_request) {
        this.sync.applyIssue(repo, issue);
        if (action === 'opened') {
          const number = issue.number;
          if (automationOwnerId && repoRow?.auto_triage === 1) {
            log.info('webhook: auto-triage queued', { repo, issue: number });
            void this.triage
              .triageIssue(repo, number, automationOwnerId)
              .catch((err) =>
                this.automationFailed(repo, `Auto-triage failed for ${repo}#${number}`, err, `#/repos/${repo}/issues/${number}`),
              );
          }
          // Issue-type pipelines flagged auto-run fire for every opened issue
          // (failures per pipeline are caught + logged inside autoRun).
          if (ownerId) this.pipelines.autoRunForIssue(repo, number, ownerId);
        }
      }
    }
    if (eventName === 'pull_request') {
      const pr = payload.pull_request as GhPull | undefined;
      if (pr?.number) {
        this.sync.applyPull(repo, pr);
        // A merge is when specs can silently rot — check them against the diff.
        if (ownerId && action === 'closed' && pr.merged_at) {
          const number = pr.number;
          void this.specs
            .checkDriftForMergedPr(repo, number, ownerId)
            .catch((err) =>
              this.automationFailed(repo, `Spec drift check failed for ${repo}#${number}`, err, `#/repos/${repo}/prs/${number}`),
            );
        }
        if ((action === 'opened' || action === 'ready_for_review') && pr.draft !== true) {
          const number = pr.number;
          if (automationOwnerId && repoRow?.pr_gate === 1) {
            log.info('webhook: PR gate queued', { repo, pr: number });
            void this.prReviews
              .gate(repo, number, automationOwnerId)
              .catch((err) =>
                this.automationFailed(repo, `PR gate failed for ${repo}#${number}`, err, `#/repos/${repo}/prs/${number}`),
              );
          }
          // User-defined pipelines flagged auto-run fire for every opened PR
          // (failures per pipeline are caught + logged inside autoRun).
          if (ownerId) this.pipelines.autoRunForPr(repo, number, ownerId);
        }
      }
    }
    // Background reconcile for whatever the payload didn't carry (comment
    // counts, anything else that changed since the last poll).

    this.store.reports.insert({
      issueNumber: null,
      id: `rep-${randomUUID().slice(0, 12)}`,
      workspaceId: null,
      repo,
      kind: 'webhook',
      title: `${eventName}${action ? `.${action}` : ''}`,
      body: `Delivery accepted for ${repo}.`,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
    return { status: 202, body: 'accepted' };
  }

  // ---------- schedules -----------------------------------------------------------

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run due schedules. Digest/stale/briefing run per period; auto-merge every tick. */
  async tick(now = Date.now()): Promise<void> {
    for (const repo of this.store.repos.list()) {
      const ownerId = repo.automation_owner_id ?? null;
      if (ownerId && repo.digest_enabled === 1 && this.due(`digest:${repo.full_name}`, now)) {
        // Fire-and-forget: runDigest stamps lastRun synchronously, so the next
        // tick won't re-fire while this one is still working.
        this.startDigest(repo.full_name, ownerId);
      }
      if (repo.stale_enabled === 1 && this.due(`stale:${repo.full_name}`, now)) {
        this.runStaleSweep(repo.full_name);
      }
      if (ownerId && repo.auto_merge === 1) {
        await this.autoMergeSweep(repo.full_name, ownerId).catch((err) =>
          log.warn('auto-merge sweep failed', { repo: repo.full_name, err: String(err) }),
        );
      }
    }
    for (const ws of this.store.workspaces.list()) {
      const cadence = this.briefingCadence(ws.id);
      if (cadence === 'off') continue;
      const period = cadence === 'weekly' ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
      if (this.due(`briefing:${ws.id}`, now, period)) {
        await this.runBriefing(ws.id).catch((err) =>
          log.warn('briefing failed', { workspace: ws.id, err: String(err) }),
        );
      }
    }
  }

  // ---------- auto-merge ------------------------------------------------------------

  /**
   * The boring 40%: open, not draft, human-approved, latest AI review says low
   * risk, CI green. Every candidate is re-verified with a FRESH checks fetch
   * (which also refreshes the human decision) right before merging — the cache
   * nominates, GitHub confirms. A failed merge backs off for 6 hours.
   */
  async autoMergeSweep(repo: string, userId: string): Promise<void> {
    const client = this.github(repo, userId);
    if (!client) return;
    const candidates = this.store.prs
      .list(repo)
      .filter(
        (pr) =>
          pr.state === 'open' &&
          !pr.draft &&
          pr.reviewDecision === 'approved' &&
          pr.reviewRisk === 'low' &&
          pr.checks?.state === 'passing',
      );
    for (const pr of candidates) {
      const guard = `automerge:${repo}#${pr.number}`;
      if (!this.due(guard, Date.now(), 6 * 60 * 60_000)) continue;
      this.store.settings.set(`lastRun:${guard}`, String(Date.now()));
      const fresh = await this.prChecks.trySummary(repo, pr.number, userId);
      const row = this.store.prs.get(repo, pr.number);
      if (
        !fresh ||
        fresh.state !== 'passing' ||
        row?.state !== 'open' ||
        row.reviewDecision !== 'approved' ||
        row.reviewRisk !== 'low'
      ) {
        continue;
      }
      try {
        await client.mergePr(repo, pr.number, 'squash');
        await client
          .comment(repo, pr.number, 'Auto-merged by Companion: CI green, human-approved, AI review risk low.')
          .catch(() => undefined);
        log.info('auto-merged PR', { repo, prNumber: pr.number });
        this.notify(repo, 'finished', `Auto-merged ${repo}#${pr.number}`, pr.title, `#/repos/${repo}/prs/${pr.number}`);
      } catch (err) {
        this.automationFailed(repo, `Auto-merge failed for ${repo}#${pr.number}`, err, `#/repos/${repo}/prs/${pr.number}`);
      }
    }
  }

  // ---------- workspace briefing ------------------------------------------------------

  briefingCadence(workspaceId: string): BriefingCadence {
    const raw = this.store.settings.get(`briefing:${workspaceId}`);
    return raw === 'daily' || raw === 'weekly' ? raw : 'off';
  }

  setBriefingCadence(workspaceId: string, cadence: BriefingCadence): void {
    this.store.settings.set(`briefing:${workspaceId}`, cadence);
  }

  /**
   * The "start your day here" report: everything awaiting a human, what the
   * agents did since yesterday, CI health, hot issues, velocity. Deterministic
   * (no tokens) — it summarizes state Companion already holds.
   */
  async runBriefing(workspaceId: string): Promise<void> {
    const ws = this.store.workspaces.get(workspaceId);
    if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
    this.store.settings.set(`lastRun:briefing:${workspaceId}`, String(Date.now()));
    const repoNames = new Set(this.store.repos.listByWorkspace(workspaceId).map((r) => r.full_name));
    const dayAgo = Date.now() - 24 * 60 * 60_000;

    const sections: string[] = [];
    const openPrs = this.store.prs.listWorkspace(workspaceId).filter((pr) => pr.state === 'open');
    const openIssues = this.store.issues.listWorkspace(workspaceId, 'open');

    // What needs a human, right now — mirrors the Overview "Needs attention" queue.
    // Reviews and triage now live on the PR and issue records themselves.
    const reviewRuns = this.store.runs.list(500).filter((r) => r.status === 'review' && r.repo && repoNames.has(r.repo));
    const pendingReviews = openPrs.filter((pr) => pr.review === 'pending');
    const pendingTriage = openIssues.filter((i) => i.triage === 'pending');
    const pendingProposals = this.store.proposals
      .listWorkspace(workspaceId)
      .filter((p) => p.status === 'analyzed' || p.status === 'review');
    const needsYou = [
      ...reviewRuns.map((r) => `- Agent change awaiting review: [${r.title}](#/runs/${r.id}/preview)`),
      ...pendingReviews.map((pr) => `- AI review to post: [${pr.repo}#${pr.number}](#/repos/${pr.repo}/prs/${pr.number}/review) — ${pr.title}`),
      ...pendingTriage.map((i) => `- Triage to apply: [${i.repo}#${i.number}](#/repos/${i.repo}/issues/${i.number}) — ${i.title}`),
      ...pendingProposals.map((p) => `- Legacy proposal ${p.status === 'review' ? 'ready for review' : 'awaiting approval'}: [${p.title}](#/legacy-proposals)`),
    ];
    sections.push(`## Needs you (${needsYou.length})\n${needsYou.length ? needsYou.join('\n') : 'Inbox zero — nothing is waiting on you.'}`);

    // What the agents did while you were away.
    const recent = this.store.runs.list(500).filter((r) => r.created_at >= dayAgo && r.repo && repoNames.has(r.repo));
    const byKind = new Map<string, number>();
    for (const r of recent) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const failed = recent.filter((r) => r.status === 'failed');
    const agentLines = [
      recent.length === 0
        ? 'No agent activity in the last 24h.'
        : `${recent.length} run(s): ${[...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(', ')}.`,
      ...failed.map((r) => `- Failed: [${r.title}](#/runs/${r.id}/preview)`),
    ];
    sections.push(`## Agents, last 24h\n${agentLines.join('\n')}`);

    // CI health across open PRs.
    const failing = openPrs.filter((pr) => pr.checks?.state === 'failing');
    sections.push(
      `## CI health\n${openPrs.length} open PR(s); ${failing.length} failing.` +
        (failing.length ? `\n${failing.map((pr) => `- [${pr.repo}#${pr.number}](#/repos/${pr.repo}/prs/${pr.number}) ${pr.title}`).join('\n')}` : ''),
    );

    // Hot issues: touched in the last day, most discussed first.
    const hot = openIssues
      .filter((i) => i.updatedAt >= dayAgo)
      .sort((a, b) => b.comments - a.comments)
      .slice(0, 5);
    if (hot.length > 0) {
      sections.push(`## Hot issues\n${hot.map((i) => `- [${i.repo}#${i.number}](#/repos/${i.repo}/issues/${i.number}) ${i.title} (${i.comments} comments)`).join('\n')}`);
    }

    // Velocity, rolling 7 days.
    const m = this.store.workspaces.metrics(workspaceId);
    sections.push(
      `## Velocity (7d)\nIssues: ${m.issuesOpened7d} opened / ${m.issuesClosed7d} closed · PRs: ${m.prsOpened7d} opened / ${m.prsClosed7d} closed.`,
    );

    this.store.reports.insert({
      id: `rep-${randomUUID().slice(0, 12)}`,
      workspaceId,
      repo: null,
      issueNumber: null,
      kind: 'briefing',
      title: `Briefing — ${ws.name}`,
      body: sections.join('\n\n'),
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
    this.store.notifications.insert({
      id: `ntf-${randomUUID().slice(0, 12)}`,
      workspaceId,
      repo: null,
      kind: 'info',
      title: `Briefing ready — ${ws.name}`,
      body: 'A new workspace briefing is ready.',
      href: '#/automations',
      createdAt: Date.now(),
    });
  }

  private readonly digestsInFlight = new Set<string>();

  /**
   * Kick off a digest WITHOUT holding the caller. The run takes minutes —
   * longer than Node's 5-minute request timeout — so the HTTP route must not
   * await it (the socket gets destroyed and the browser sees a 500 while the
   * digest quietly completes). Failures land in the inbox; the report lands
   * via `reports.changed`. Returns false when one is already running.
   */
  startDigest(repo: string, userId?: string): boolean {
    if (this.digestsInFlight.has(repo)) return false;
    this.digestsInFlight.add(repo);
    void this.runDigest(repo, userId)
      .catch((err) => this.automationFailed(repo, `Digest failed for ${repo}`, err, '#/digest'))
      .finally(() => this.digestsInFlight.delete(repo));
    return true;
  }

  /**
   * The AI repo review: everything that moved since the last digest — shipped,
   * failed, new, in flight — grounded in tracker state Companion already holds,
   * then handed to an agent inside the clone to judge what matters and where
   * the project is heading. Falls back to the deterministic fact sheet when the
   * agent (or the clone) is unavailable, so the report always lands.
   */
  async runDigest(repo: string, userId?: string): Promise<void> {
    const since = Number(this.store.settings.get(`lastRun:digest:${repo}`) ?? 0) || Date.now() - 86_400_000;
    this.store.settings.set(`lastRun:digest:${repo}`, String(Date.now()));

    const freshIssues = this.store.issues.listSince(repo, since);
    const prs = this.store.prs.list(repo);
    const merged = prs.filter((pr) => pr.state === 'merged' && (pr.closedAt ?? 0) >= since);
    const openPrs = prs.filter((pr) => pr.state === 'open');
    const failingPrs = openPrs.filter((pr) => pr.checks?.state === 'failing');
    const allRuns = this.store.runs.list(500);
    const recentRuns = allRuns.filter((r) => r.repo === repo && r.created_at >= since);
    const failedRuns = recentRuns.filter((r) => r.status === 'failed');
    const reviewRuns = allRuns.filter((r) => r.repo === repo && r.status === 'review');

    const prLink = (n: number): string => `[${repo}#${n}](#/repos/${repo}/prs/${n})`;
    const issueLink = (n: number): string => `[${repo}#${n}](#/repos/${repo}/issues/${n})`;

    // The fact sheet: grounds the agent AND doubles as the fallback body.
    const facts: string[] = [];
    facts.push(
      `## Shipped since last digest\n${
        merged.length
          ? merged.slice(0, 20).map((pr) => `- ${prLink(pr.number)} ${pr.title} (${pr.author})`).join('\n')
          : 'No PRs merged.'
      }`,
    );
    const broken = [
      ...failingPrs.slice(0, 10).map((pr) => `- CI failing on ${prLink(pr.number)} ${pr.title}`),
      ...failedRuns.slice(0, 10).map((r) => `- Agent run failed: [${r.title}](#/runs/${r.id})${r.outcome ? ` — ${r.outcome.slice(0, 200)}` : ''}`),
    ];
    facts.push(`## Failing\n${broken.length ? broken.join('\n') : 'CI green on open PRs; no failed agent runs.'}`);
    facts.push(
      `## New issues\n${
        freshIssues.length
          ? freshIssues
              .slice(0, 15)
              .map((i) => `- ${issueLink(i.number)} ${i.title} (${i.author})${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`)
              .join('\n')
          : 'No new issues.'
      }`,
    );
    const inFlight = [
      ...openPrs
        .filter((pr) => !pr.draft && pr.checks?.state !== 'failing')
        .slice(0, 15)
        .map((pr) => `- ${prLink(pr.number)} ${pr.title}${pr.reviewDecision === 'approved' ? ' (approved, mergeable)' : ''}`),
      ...reviewRuns.map((r) => `- Agent diff awaiting human review: [${r.title}](#/runs/${r.id})`),
    ];
    facts.push(`## In flight\n${inFlight.length ? inFlight.join('\n') : 'Nothing in flight.'}`);

    const quiet =
      freshIssues.length === 0 && merged.length === 0 && failingPrs.length === 0 && recentRuns.length === 0;

    let body = quiet ? 'Quiet since the last digest — nothing shipped, failed, or arrived.' : facts.join('\n\n');
    if (!quiet && userId && this.checkouts.hasClone(repo)) {
      try {
        // Fresh git history is the "what actually landed" source for the agent.
        await this.checkouts.fetch(repo, undefined, userId).catch(() => undefined);
        const sinceIso = new Date(since).toISOString();
        const { finalMessage } = await this.orchestrator.runOneShot({
          kind: 'report',
          task: 'automations.digest',
          title: `Digest: ${repo}`,
          cwd: this.checkouts.cloneDir(repo),
          repo,
          userId,
          prompt:
            `You are writing the daily digest for ${repo} — the AI review a maintainer reads first thing. Do not modify any files.\n\n` +
            `Ground truth from Companion's tracker (trust it; add judgement, don't restate it verbatim):\n\n${facts.join('\n\n')}\n\n` +
            (freshIssues.length
              ? `New issue bodies:\n${freshIssues.slice(0, 15).map((i) => `### #${i.number} ${i.title}\n${i.body.slice(0, 1200)}`).join('\n\n')}\n\n`
              : '') +
            `You are inside a clone of the repository. Run read-only git commands (e.g. \`git log --stat --since="${sinceIso}" origin/HEAD\`) to see what actually changed, and read code or docs where it sharpens your judgement. Budget your exploration: a handful of git commands and at most a few file reads, then write — a good digest on time beats a perfect one that never lands.\n\n` +
            `Reply in markdown with exactly these sections:\n` +
            `## Headline — 2-3 sentences: the state of the repo today and the single most important thing.\n` +
            `## What matters now — prioritized checklist (max 5) of what deserves attention first, each with a one-line why.\n` +
            `## Done — what shipped since the last digest, grouped by theme, from merged PRs and git history.\n` +
            `## Failed or blocked — failing CI, failed agent runs, stuck PRs; each with the likely cause in one line.\n` +
            `## Direction — 2-4 sentences: where the project is heading given recent activity vs the open backlog; call out drift or risk.\n\n` +
            `Link issues/PRs as [${repo}#N](#/repos/${repo}/issues/N) or (#/repos/${repo}/prs/N). Be specific and terse; no filler.`,
          timeoutMs: 12 * 60_000,
        });
        if (finalMessage?.trim()) body = finalMessage.trim();
      } catch (err) {
        log.warn('digest agent failed, using fact sheet', { err: String(err) });
      }
    }

    this.store.reports.insert({
      issueNumber: null,
      id: `rep-${randomUUID().slice(0, 12)}`,
      workspaceId: null,
      repo,
      kind: 'digest',
      title: `Daily digest — ${repo}`,
      body,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
    if (!quiet) {
      this.notify(
        repo,
        'info',
        `Daily digest ready — ${repo}`,
        `${merged.length} merged · ${failingPrs.length} failing CI · ${freshIssues.length} new issue(s)`,
        '#/digest',
      );
    }
  }

  runStaleSweep(repo: string, staleDays = 30): void {
    this.store.settings.set(`lastRun:stale:${repo}`, String(Date.now()));
    const stale = this.store.issues.listStale(repo, staleDays);
    const body =
      stale.length === 0
        ? `No open issues idle for more than ${staleDays} days.`
        : stale.map((i) => `- #${i.number} ${i.title} — idle since ${new Date(i.updatedAt).toDateString()}`).join('\n');
    this.store.reports.insert({
      issueNumber: null,
      id: `rep-${randomUUID().slice(0, 12)}`,
      workspaceId: null,
      repo,
      kind: 'stale-sweep',
      title: `Stale sweep — ${stale.length} issue(s) idle >${staleDays}d`,
      body,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
  }

  private due(key: string, now: number, periodMs = 24 * 60 * 60_000): boolean {
    const last = Number(this.store.settings.get(`lastRun:${key}`) ?? 0);
    return now - last >= periodMs;
  }

  private notify(repo: string, kind: NotificationKind, title: string, body: string, href: string | null): void {
    this.store.notifications.insert({
      id: `ntf-${randomUUID().slice(0, 12)}`,
      workspaceId: this.store.repos.get(repo)?.workspace_id ?? null,
      repo,
      kind,
      title,
      body,
      href,
      createdAt: Date.now(),
    });
  }

  /** Automation failures must be visible in the inbox, not just a daemon log line. */
  private automationFailed(repo: string, title: string, err: unknown, href: string | null): void {
    log.warn(title, { err: String(err) });
    this.store.notifications.insert({
      id: `ntf-${randomUUID().slice(0, 12)}`,
      workspaceId: this.store.repos.get(repo)?.workspace_id ?? null,
      repo,
      kind: 'error',
      title,
      body: String(err),
      href,
      createdAt: Date.now(),
    });
  }
}

function verifySignature(secret: string, rawBody: Buffer, header: string): boolean {
  if (!header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
