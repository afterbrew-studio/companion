import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SpaServerMessage, WebhookInfo } from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Triage } from '../triage/triage.js';
import type { PrReviews } from '../prs/reviews.js';
import type { GitHubSync } from '../github/sync.js';
import type { Checkouts } from '../git/checkouts.js';

/**
 * Automations: a GitHub webhook receiver (HMAC-verified, raw body) and a slow
 * schedule ticker (daily digest, stale sweep). Rules are per-repo switches.
 */
export class Automations {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly triage: Triage,
    private readonly prReviews: PrReviews,
    private readonly sync: GitHubSync,
    private readonly checkouts: Checkouts,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  // ---------- webhooks -----------------------------------------------------------

  /** Enable the receiver for a repo: mint (or return) its HMAC secret. */
  ensureWebhook(repo: string): WebhookInfo {
    let secret = this.store.getRepoWebhookSecret(repo);
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      this.store.setRepoWebhookSecret(repo, secret);
      this.broadcast({ t: 'repos.changed' });
    }
    return { path: `/webhooks/github/${repo}`, secret };
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
    const secret = this.store.getRepoWebhookSecret(repo);
    if (!secret) return { status: 404, body: 'webhook not configured for this repo' };

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

    // Fast-path sync on anything issue/PR shaped, then rule dispatch.
    void this.sync.syncRepo(repo).catch(() => undefined);

    const action = String(payload.action ?? '');
    const repoRow = this.store.getRepo(repo);
    if (eventName === 'issues' && action === 'opened') {
      const issue = payload.issue as { number?: number; title?: string } | undefined;
      if (issue?.number && repoRow?.auto_triage === 1) {
        log.info('webhook: auto-triage queued', { repo, issue: issue.number });
        // Sync first so the issue row exists, then triage; fire-and-forget.
        void this.sync
          .syncRepo(repo)
          .then(() => this.triage.triageIssue(repo, issue.number!))
          .catch((err) => log.warn('auto-triage failed', { err: String(err) }));
      }
    }
    if (eventName === 'pull_request' && (action === 'opened' || action === 'ready_for_review')) {
      const pr = payload.pull_request as { number?: number; draft?: boolean } | undefined;
      if (pr?.number && pr.draft !== true && repoRow?.pr_gate === 1) {
        log.info('webhook: PR gate queued', { repo, pr: pr.number });
        void this.sync
          .syncRepo(repo)
          .then(() => this.prReviews.gate(repo, pr.number!))
          .catch((err) => log.warn('PR gate failed', { err: String(err) }));
      }
    }

    this.store.insertReport({
      id: `rep-${randomUUID().slice(0, 12)}`,
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

  /** Run due schedules. Digest/stale run at most once per 24h per repo. */
  async tick(now = Date.now()): Promise<void> {
    for (const repo of this.store.listRepos()) {
      if (repo.digest_enabled === 1 && this.due(`digest:${repo.full_name}`, now)) {
        await this.runDigest(repo.full_name).catch((err) =>
          log.warn('digest failed', { repo: repo.full_name, err: String(err) }),
        );
      }
      if (repo.stale_enabled === 1 && this.due(`stale:${repo.full_name}`, now)) {
        this.runStaleSweep(repo.full_name);
      }
    }
  }

  /** Force a schedule to run now (UI button + tests). */
  async runDigest(repo: string): Promise<void> {
    const since = Number(this.store.getSetting(`lastRun:digest:${repo}`) ?? 0) || Date.now() - 86_400_000;
    const fresh = this.store.listIssuesSince(repo, since);
    this.store.setSetting(`lastRun:digest:${repo}`, String(Date.now()));

    let body: string;
    if (fresh.length === 0) {
      body = 'No new issues since the last digest.';
    } else {
      const list = fresh
        .map((i) => `- #${i.number} ${i.title} (${i.author})${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`)
        .join('\n');
      // A bounded agent turn summarizes; fall back to the raw list on failure.
      body = list;
      if (this.checkouts.hasClone(repo)) {
        try {
          const { finalMessage } = await this.orchestrator.runOneShot({
            kind: 'report',
            title: `Digest: ${repo}`,
            cwd: this.checkouts.cloneDir(repo),
            repo,
            prompt: `You are writing a maintainer's daily digest for ${repo}. Do not modify any files.\n\nNew issues since the last digest:\n${list}\n\nEach issue body:\n${fresh.map((i) => `### #${i.number} ${i.title}\n${i.body.slice(0, 1500)}`).join('\n\n')}\n\nReply with a concise markdown digest: 2-3 sentences of overall assessment, then a prioritized checklist of what deserves attention first and why.`,
            timeoutMs: 5 * 60_000,
          });
          if (finalMessage?.trim()) body = finalMessage.trim();
        } catch (err) {
          log.warn('digest agent failed, using raw list', { err: String(err) });
        }
      }
    }

    this.store.insertReport({
      id: `rep-${randomUUID().slice(0, 12)}`,
      repo,
      kind: 'digest',
      title: `Daily digest — ${fresh.length} new issue(s)`,
      body,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
  }

  runStaleSweep(repo: string, staleDays = 30): void {
    this.store.setSetting(`lastRun:stale:${repo}`, String(Date.now()));
    const stale = this.store.listStaleIssues(repo, staleDays);
    const body =
      stale.length === 0
        ? `No open issues idle for more than ${staleDays} days.`
        : stale.map((i) => `- #${i.number} ${i.title} — idle since ${new Date(i.updatedAt).toDateString()}`).join('\n');
    this.store.insertReport({
      id: `rep-${randomUUID().slice(0, 12)}`,
      repo,
      kind: 'stale-sweep',
      title: `Stale sweep — ${stale.length} issue(s) idle >${staleDays}d`,
      body,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
  }

  private due(key: string, now: number): boolean {
    const last = Number(this.store.getSetting(`lastRun:${key}`) ?? 0);
    return now - last >= 24 * 60 * 60_000;
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
