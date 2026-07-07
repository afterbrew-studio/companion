import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SpaServerMessage, WebhookInfo } from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Triage } from '../triage/triage.js';
import type { PrReviews } from '../prs/reviews.js';
import type { Pipelines } from '../pipelines/pipelines.js';
import type { GitHubSync } from '../github/sync.js';
import type { GhIssue, GhPull } from '../github/client.js';
import type { Checkouts } from '../git/checkouts.js';
import type { WebhookTunnel } from '../moxxy/webhook-tunnel.js';

/**
 * Automations: a GitHub webhook receiver (HMAC-verified, raw body) and a slow
 * schedule ticker (daily digest, stale sweep). Rules are per-repo switches;
 * user-defined pipelines with auto-run also fire here on PR open.
 */
export class Automations {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly triage: Triage,
    private readonly prReviews: PrReviews,
    private readonly pipelines: Pipelines,
    private readonly sync: GitHubSync,
    private readonly checkouts: Checkouts,
    private readonly webhookTunnel: WebhookTunnel,
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
    const path = `/webhooks/github/${repo}`;
    return { path, secret, url: this.webhookTunnel.deliveryUrl(path) };
  }

  /** Disable the receiver for a repo: deliveries 401/404 until re-enabled. */
  disableWebhook(repo: string): void {
    this.store.setRepoWebhookSecret(repo, null);
    this.broadcast({ t: 'repos.changed' });
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

    // The delivery carries the full changed object — apply it to the cache
    // right away. Automation below must never wait on (or race) the slower
    // REST sync: before this, triage fired against an issue that wasn't in
    // the store yet and died on "unknown issue".
    const action = String(payload.action ?? '');
    const repoRow = this.store.getRepo(repo);
    if (eventName === 'issues') {
      const issue = payload.issue as GhIssue | undefined;
      if (issue?.number && !issue.pull_request) {
        this.sync.applyIssue(repo, issue);
        if (action === 'opened') {
          const number = issue.number;
          if (repoRow?.auto_triage === 1) {
            log.info('webhook: auto-triage queued', { repo, issue: number });
            void this.triage
              .triageIssue(repo, number)
              .catch((err) =>
                this.automationFailed(repo, `Auto-triage failed for ${repo}#${number}`, err, `#/repos/${repo}/issues/${number}`),
              );
          }
          // Issue-type pipelines flagged auto-run fire for every opened issue
          // (failures per pipeline are caught + logged inside autoRun).
          this.pipelines.autoRunForIssue(repo, number);
        }
      }
    }
    if (eventName === 'pull_request') {
      const pr = payload.pull_request as GhPull | undefined;
      if (pr?.number) {
        this.sync.applyPull(repo, pr);
        if ((action === 'opened' || action === 'ready_for_review') && pr.draft !== true) {
          const number = pr.number;
          if (repoRow?.pr_gate === 1) {
            log.info('webhook: PR gate queued', { repo, pr: number });
            void this.prReviews
              .gate(repo, number)
              .catch((err) =>
                this.automationFailed(repo, `PR gate failed for ${repo}#${number}`, err, `#/repos/${repo}/prs/${number}`),
              );
          }
          // User-defined pipelines flagged auto-run fire for every opened PR
          // (failures per pipeline are caught + logged inside autoRun).
          this.pipelines.autoRunForPr(repo, number);
        }
      }
    }
    // Background reconcile for whatever the payload didn't carry (comment
    // counts, anything else that changed since the last poll).
    void this.sync.syncRepo(repo).catch(() => undefined);

    this.store.insertReport({
      issueNumber: null,
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
      issueNumber: null,
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
      issueNumber: null,
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

  /** Automation failures must be visible in the inbox, not just a daemon log line. */
  private automationFailed(repo: string, title: string, err: unknown, href: string | null): void {
    log.warn(title, { err: String(err) });
    this.store.insertNotification({
      id: `ntf-${randomUUID().slice(0, 12)}`,
      workspaceId: this.store.getRepo(repo)?.workspace_id ?? null,
      kind: 'error',
      title,
      body: String(err),
      href,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'notifications.changed' });
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
