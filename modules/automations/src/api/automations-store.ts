import { legacyNotifications, type NotificationEmitter, type Database } from '@moxxy/companion-sdk/server';
import type { ServiceMap } from '@moxxy/companion-contracts';
import type {
  ActionableIssueKind,
  AutomationAdmissionControl,
  AutomationDeliveryHealth,
  AutomationDeliveryRecord,
  AutomationDeliveryStatus,
  ContributorFlowPolicy,
} from '../contract/index.js';
import type { IssuesStore, PrsStore, ReposStore, RunsStore } from './cross-types.js';

export const DELIVERY_ACTIVE_GLOBAL_LIMIT = 1_000;
export const DELIVERY_ACTIVE_REPO_LIMIT = 250;
export type DeliveryEnqueueResult = 'accepted' | 'duplicate' | 'paused' | 'saturated';
export type DeliveryRetryResult = 'retried' | 'not-found' | 'paused' | 'saturated';
const DELIVERY_HEALTH_REPO_BATCH = 400;

export interface AutomationDeliveryJob extends AutomationDeliveryRecord {
  readonly payload: string;
  /** Internal serialization lane; never crosses to the SPA. */
  readonly orderingKey: string;
}

/**
 * The automations domain's view of persistence — a same-shape stand-in for the
 * legacy Store facade so the moved service bodies (automations/assistant) stay
 * verbatim. This module owns the bounded durable delivery inbox and repository
 * contributor-flow policies; other domain state is injected — `repos` /
 * `issues` / `prs` (module-code's stores, reached through its service bundle),
 * `runs` (operate's runs store, exposed on its bundle exactly for this),
 * `reports` (module-workspace's), `settings` (module-core), `workspaces`
 * (module-workspace's access-control owner) and `notifications` (an adapter
 * over ctx.notify).
 */
export class AutomationsStore {
  readonly repos: ReposStore;
  readonly issues: IssuesStore;
  readonly prs: PrsStore;
  readonly runs: RunsStore;
  readonly workspaces: ServiceMap['workspace'];
  readonly reports: ServiceMap['reports'];
  readonly settings: { get(key: string): string | null; set(key: string, value: string): void };
  private readonly db: Database;
  private readonly notify: NotificationEmitter;
  private nextDeliveryPurgeAt = 0;

  constructor(opts: {
    db: Database;
    repos: ReposStore;
    issues: IssuesStore;
    prs: PrsStore;
    runs: RunsStore;
    workspaces: ServiceMap['workspace'];
    reports: ServiceMap['reports'];
    settings: { get(key: string): string | null; set(key: string, value: string): void };
    notify: NotificationEmitter;
  }) {
    this.db = opts.db;
    this.repos = opts.repos;
    this.issues = opts.issues;
    this.prs = opts.prs;
    this.runs = opts.runs;
    this.workspaces = opts.workspaces;
    this.reports = opts.reports;
    this.settings = opts.settings;
    this.notify = opts.notify;
  }

  /** Legacy `notifications.insert({...})` call shape, routed through the shared emitter. */
  readonly notifications = legacyNotifications(() => this.notify);

  /** Persist before acknowledging GitHub. The payload is a bounded projection,
   * not the raw request, and never leaves this store. */
  enqueueDelivery(input: {
    id: string;
    repo: string;
    event: string;
    action: string;
    payload: string;
    orderingKey: string;
  }, now = Date.now()): DeliveryEnqueueResult {
    const enqueue = this.db.transaction((): DeliveryEnqueueResult => {
      // Capacity must never turn a GitHub retry of an already-durable event
      // into a 503 loop. Check identity before checking the backlog ceiling.
      const duplicate = this.db.prepare(`SELECT 1 FROM automation_deliveries WHERE id = ?`).get(input.id);
      if (duplicate) return 'duplicate';
      const paused = this.db.prepare(`SELECT 1 FROM automation_admission_controls WHERE repo = ?`).get(input.repo);
      if (paused) return 'paused';
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN repo = ? THEN 1 ELSE 0 END), 0) AS repo_count
           FROM automation_deliveries
           WHERE status IN ('queued', 'retrying', 'processing')`,
        )
        .get(input.repo) as { total: number; repo_count: number };
      if (active.total >= DELIVERY_ACTIVE_GLOBAL_LIMIT || active.repo_count >= DELIVERY_ACTIVE_REPO_LIMIT) {
        return 'saturated';
      }
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO automation_deliveries
             (id, repo, event, action, payload, ordering_key, status, stage, attempts,
              received_at, started_at, next_attempt_at, last_error, completed_at)
           VALUES (@id, @repo, @event, @action, @payload, @orderingKey, 'queued', 'Accepted by webhook', 0,
                   @now, NULL, @now, NULL, NULL)`,
        )
        .run({ ...input, orderingKey: input.orderingKey.slice(0, 500) || input.repo, now });
      return result.changes === 1 ? 'accepted' : 'duplicate';
    });
    const outcome = enqueue();
    if (outcome === 'accepted' && now >= this.nextDeliveryPurgeAt) {
      this.purgeDeliveries(now);
      this.nextDeliveryPurgeAt = now + 60 * 60_000;
    }
    return outcome;
  }

  /**
   * Atomically lease a bounded set of due jobs to this daemon.
   *
   * At most one delivery per issue/PR/SHA lane can be leased at once. Processing
   * `synchronize` ahead of `opened` would make the cache and expensive review
   * gates race; serialising every event in a busy repository would make one
   * huge PR block every other contributor. A retrying head-of-line delivery
   * holds only its subject while unrelated work uses the worker pool.
   */
  claimDueDeliveries(
    limit: number,
    now = Date.now(),
    excludedOrderingKeys: readonly string[] = [],
  ): AutomationDeliveryJob[] {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 0), 32);
    if (boundedLimit === 0) return [];
    const exclusions = [...new Set(excludedOrderingKeys)];
    const excludedSql = exclusions.length > 0
      ? `AND delivery.ordering_key NOT IN (${exclusions.map(() => '?').join(', ')})`
      : '';
    const claim = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT delivery.id FROM automation_deliveries AS delivery
           WHERE delivery.status IN ('queued', 'retrying')
             AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ?)
             ${excludedSql}
             AND NOT EXISTS (
               SELECT 1 FROM automation_deliveries AS earlier
               WHERE earlier.ordering_key = delivery.ordering_key
                 AND earlier.status IN ('queued', 'retrying', 'processing')
                 AND earlier.rowid < delivery.rowid
             )
           ORDER BY delivery.rowid LIMIT ?`,
        )
        .all(now, ...exclusions, boundedLimit) as Array<{ id: string }>;
      const jobs: AutomationDeliveryJob[] = [];
      for (const { id } of rows) {
        const changed = this.db
          .prepare(
            `UPDATE automation_deliveries
             SET status = 'processing', stage = 'Starting', attempts = attempts + 1,
                 started_at = ?, next_attempt_at = NULL, last_error = NULL
             WHERE id = ? AND status IN ('queued', 'retrying')`,
          )
          .run(now, id);
        if (changed.changes !== 1) continue;
        const job = this.deliveryJob(id);
        if (job) jobs.push(job);
      }
      return jobs;
    });
    return claim();
  }

  updateDeliveryStage(id: string, stage: string): void {
    this.db
      .prepare(`UPDATE automation_deliveries SET stage = ? WHERE id = ? AND status = 'processing'`)
      .run(stage.slice(0, 240), id);
  }

  completeDelivery(id: string, stage = 'Completed', now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE automation_deliveries
         SET status = 'completed', stage = ?, completed_at = ?, next_attempt_at = NULL, last_error = NULL
         WHERE id = ? AND status = 'processing'`,
      )
      .run(stage.slice(0, 240), now, id);
  }

  failDelivery(id: string, error: string, maxAttempts: number, now = Date.now()): AutomationDeliveryStatus {
    const row = this.db
      .prepare(`SELECT attempts FROM automation_deliveries WHERE id = ?`)
      .get(id) as { attempts: number } | undefined;
    if (!row) return 'failed';
    const terminal = row.attempts >= maxAttempts;
    const delay = Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, row.attempts - 1));
    const status: AutomationDeliveryStatus = terminal ? 'failed' : 'retrying';
    this.db
      .prepare(
        `UPDATE automation_deliveries
         SET status = ?, stage = ?, last_error = ?, next_attempt_at = ?, completed_at = NULL
         WHERE id = ? AND status = 'processing'`,
      )
      .run(
        status,
        terminal ? 'Needs attention' : `Retrying in ${Math.round(delay / 1000)}s`,
        error.slice(0, 2_000),
        terminal ? null : now + delay,
        id,
      );
    return status;
  }

  /** Processing is a process-local lease. A restart releases every one. */
  recoverDeliveries(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE automation_deliveries
         SET status = 'retrying', stage = 'Recovered after restart', next_attempt_at = ?,
             last_error = COALESCE(last_error, 'daemon restarted while delivery was processing')
         WHERE status = 'processing'`,
      )
      .run(now).changes;
  }

  retryDelivery(id: string, allowedRepos: readonly string[], now = Date.now()): DeliveryRetryResult {
    const retry = this.db.transaction((): DeliveryRetryResult => {
      const repo = this.deliveryRepo(id);
      if (!repo || !allowedRepos.includes(repo)) return 'not-found';
      const failed = this.db
        .prepare(`SELECT 1 FROM automation_deliveries WHERE id = ? AND status = 'failed'`)
        .get(id);
      if (!failed) return 'not-found';
      if (this.isAdmissionPaused(repo)) return 'paused';
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN repo = ? THEN 1 ELSE 0 END), 0) AS repo_count
           FROM automation_deliveries
           WHERE status IN ('queued', 'retrying', 'processing')`,
        )
        .get(repo) as { total: number; repo_count: number };
      if (active.total >= DELIVERY_ACTIVE_GLOBAL_LIMIT || active.repo_count >= DELIVERY_ACTIVE_REPO_LIMIT) {
        return 'saturated';
      }
      const changed = this.db
        .prepare(
          `UPDATE automation_deliveries
           SET status = 'retrying', stage = 'Retry requested', attempts = 0,
               next_attempt_at = ?, last_error = NULL, completed_at = NULL
           WHERE id = ? AND status = 'failed'`,
        )
        .run(now, id).changes;
      return changed === 1 ? 'retried' : 'not-found';
    });
    return retry();
  }

  deliveryHealth(repos: readonly string[], limit = 40): AutomationDeliveryHealth {
    if (repos.length === 0) return { queued: 0, processing: 0, retrying: 0, failed: 0, recent: [] };
    const scopedRepos = [...new Set(repos)];
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const byStatus = new Map<AutomationDeliveryStatus, number>();
    const rows: Array<DeliveryRow & { sequence: number }> = [];
    // A workspace may contain more repositories than SQLite accepts bind
    // parameters in one statement. Keep access scoping by the caller-provided
    // set, but query it in fixed-size batches and merge the bounded result.
    for (let offset = 0; offset < scopedRepos.length; offset += DELIVERY_HEALTH_REPO_BATCH) {
      const batch = scopedRepos.slice(offset, offset + DELIVERY_HEALTH_REPO_BATCH);
      const placeholders = batch.map(() => '?').join(', ');
      const counts = this.db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM automation_deliveries
           WHERE repo IN (${placeholders}) AND status != 'completed'
           GROUP BY status`,
        )
        .all(...batch) as Array<{ status: AutomationDeliveryStatus; n: number }>;
      for (const row of counts) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.n);
      rows.push(
        ...(this.db
          .prepare(
            `SELECT *, rowid AS sequence FROM automation_deliveries WHERE repo IN (${placeholders})
             ORDER BY CASE status
                        WHEN 'failed' THEN 0
                        WHEN 'processing' THEN 1
                        WHEN 'retrying' THEN 2
                        WHEN 'queued' THEN 3
                        ELSE 4
                      END,
                      received_at DESC, rowid DESC
             LIMIT ?`,
          )
          .all(...batch, boundedLimit) as Array<DeliveryRow & { sequence: number }>),
      );
    }
    rows.sort(
      (a, b) =>
        deliveryStatusOrder(a.status) - deliveryStatusOrder(b.status) ||
        b.received_at - a.received_at ||
        b.sequence - a.sequence,
    );
    return {
      queued: byStatus.get('queued') ?? 0,
      processing: byStatus.get('processing') ?? 0,
      retrying: byStatus.get('retrying') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      recent: rows.slice(0, boundedLimit).map(deliveryRowToRecord),
    };
  }

  // ---------- operator admission control --------------------------------------

  admissionControl(repo: string): AutomationAdmissionControl {
    const row = this.db
      .prepare(`SELECT repo, reason, paused_by, paused_at FROM automation_admission_controls WHERE repo = ?`)
      .get(repo) as AdmissionControlRow | undefined;
    return row ? admissionControlRow(row) : openAdmissionControl(repo);
  }

  admissionControls(repos: readonly string[]): AutomationAdmissionControl[] {
    if (repos.length === 0) return [];
    const unique = [...new Set(repos)];
    const rows = this.db
      .prepare(
        `SELECT repo, reason, paused_by, paused_at
         FROM automation_admission_controls
         WHERE repo IN (SELECT value FROM json_each(?))
         ORDER BY repo`,
      )
      .all(JSON.stringify(unique)) as AdmissionControlRow[];
    const paused = new Map(rows.map((row) => [row.repo, admissionControlRow(row)]));
    return unique.map((repo) => paused.get(repo) ?? openAdmissionControl(repo));
  }

  isAdmissionPaused(repo: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM automation_admission_controls WHERE repo = ?`).get(repo));
  }

  setAdmissionControl(
    repo: string,
    paused: boolean,
    actor: string,
    reason: string,
    now = Date.now(),
  ): AutomationAdmissionControl {
    if (!paused) {
      this.db.prepare(`DELETE FROM automation_admission_controls WHERE repo = ?`).run(repo);
      return openAdmissionControl(repo);
    }
    this.db
      .prepare(
        `INSERT INTO automation_admission_controls (repo, reason, paused_by, paused_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET
           reason = excluded.reason, paused_by = excluded.paused_by, paused_at = excluded.paused_at`,
      )
      .run(repo, reason.slice(0, 500), actor, now);
    return this.admissionControl(repo);
  }

  // ---------- contributor flow policy -------------------------------------------

  contributorFlow(repo: string): ContributorFlowPolicy | null {
    const row = this.db.prepare(`SELECT * FROM contributor_flows WHERE repo = ?`).get(repo) as
      | ContributorFlowRow
      | undefined;
    return row ? contributorFlowRow(row) : null;
  }

  listContributorFlows(workspaceId: string): ContributorFlowPolicy[] {
    const rows = this.db
      .prepare(`SELECT * FROM contributor_flows WHERE workspace_id = ? ORDER BY repo`)
      .all(workspaceId) as ContributorFlowRow[];
    return rows.map(contributorFlowRow);
  }

  listAllContributorFlows(): ContributorFlowPolicy[] {
    const rows = this.db.prepare(`SELECT * FROM contributor_flows ORDER BY repo`).all() as ContributorFlowRow[];
    return rows.map(contributorFlowRow);
  }

  setContributorFlow(policy: ContributorFlowPolicy): void {
    this.db
      .prepare(
        `INSERT INTO contributor_flows
           (repo, workspace_id, mode, actionable_issue_kinds, queue_issues,
            auto_apply_triage, merge_method, max_attempts, owner_id, updated_at,
            admit_label)
         VALUES (@repo, @workspaceId, @mode, @actionableKinds, @queueIssues,
                 @autoApplyTriage, @mergeMethod, @maxAttempts, @ownerId, @updatedAt,
                 @admitLabel)
         ON CONFLICT(repo) DO UPDATE SET
           workspace_id = excluded.workspace_id, mode = excluded.mode,
           actionable_issue_kinds = excluded.actionable_issue_kinds,
           queue_issues = excluded.queue_issues, auto_apply_triage = excluded.auto_apply_triage,
           merge_method = excluded.merge_method, max_attempts = excluded.max_attempts,
           owner_id = excluded.owner_id, updated_at = excluded.updated_at,
           admit_label = excluded.admit_label`,
      )
      .run({
        repo: policy.repo,
        workspaceId: policy.workspaceId,
        mode: policy.mode,
        actionableKinds: JSON.stringify(policy.actionableIssueKinds),
        queueIssues: policy.queueIssues ? 1 : 0,
        autoApplyTriage: policy.autoApplyTriage ? 1 : 0,
        mergeMethod: policy.mergeMethod,
        maxAttempts: policy.maxAttempts,
        ownerId: policy.ownerId,
        updatedAt: policy.updatedAt,
        admitLabel: policy.admitLabel,
      });
  }

  removeContributorFlow(repo: string): void {
    this.db.prepare(`DELETE FROM contributor_flows WHERE repo = ?`).run(repo);
  }

  private deliveryJob(id: string): AutomationDeliveryJob | undefined {
    const row = this.db.prepare(`SELECT * FROM automation_deliveries WHERE id = ?`).get(id) as DeliveryRow | undefined;
    return row
      ? { ...deliveryRowToRecord(row), payload: row.payload, orderingKey: row.ordering_key }
      : undefined;
  }

  private deliveryRepo(id: string): string | null {
    const row = this.db.prepare(`SELECT repo FROM automation_deliveries WHERE id = ?`).get(id) as
      | { repo: string }
      | undefined;
    return row?.repo ?? null;
  }

  private purgeDeliveries(now: number): void {
    const purge = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM automation_deliveries
           WHERE (status = 'completed' AND received_at < ?)
              OR (status = 'failed' AND received_at < ?)`,
        )
        .run(now - 30 * 24 * 60 * 60_000, now - 90 * 24 * 60 * 60_000);
      // Time retention alone is not a bound on a high-volume forge. Keep enough
      // recent evidence for diagnosis while preventing a webhook storm from
      // growing the local database forever.
      this.db.exec(`
        DELETE FROM automation_deliveries
        WHERE status = 'completed' AND rowid NOT IN (
          SELECT rowid FROM automation_deliveries
          WHERE status = 'completed' ORDER BY received_at DESC, rowid DESC LIMIT 50000
        );
        DELETE FROM automation_deliveries
        WHERE status = 'failed' AND rowid NOT IN (
          SELECT rowid FROM automation_deliveries
          WHERE status = 'failed' ORDER BY received_at DESC, rowid DESC LIMIT 10000
        );
      `);
    });
    purge();
  }
}

interface DeliveryRow {
  id: string;
  repo: string;
  event: string;
  action: string;
  payload: string;
  ordering_key: string;
  status: AutomationDeliveryStatus;
  stage: string;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  received_at: number;
  completed_at: number | null;
}

interface ContributorFlowRow {
  repo: string;
  workspace_id: string;
  mode: ContributorFlowPolicy['mode'];
  actionable_issue_kinds: string;
  queue_issues: number;
  auto_apply_triage: number;
  merge_method: ContributorFlowPolicy['mergeMethod'];
  max_attempts: number;
  owner_id: string;
  updated_at: number;
  /** Null on a row written before the column existed. */
  admit_label: string | null;
}

interface AdmissionControlRow {
  repo: string;
  reason: string;
  paused_by: string;
  paused_at: number;
}

function openAdmissionControl(repo: string): AutomationAdmissionControl {
  return { repo, paused: false, reason: null, pausedBy: null, pausedAt: null };
}

function admissionControlRow(row: AdmissionControlRow): AutomationAdmissionControl {
  return {
    repo: row.repo,
    paused: true,
    reason: row.reason,
    pausedBy: row.paused_by,
    pausedAt: row.paused_at,
  };
}

function deliveryRowToRecord(row: DeliveryRow): AutomationDeliveryRecord {
  return {
    id: row.id,
    repo: row.repo,
    event: row.event,
    action: row.action,
    status: row.status,
    stage: row.stage,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    receivedAt: row.received_at,
    completedAt: row.completed_at,
  };
}

function deliveryStatusOrder(status: AutomationDeliveryStatus): number {
  switch (status) {
    case 'failed': return 0;
    case 'processing': return 1;
    case 'retrying': return 2;
    case 'queued': return 3;
    case 'completed': return 4;
  }
}

function contributorFlowRow(row: ContributorFlowRow): ContributorFlowPolicy {
  let kinds: ActionableIssueKind[] = [];
  try {
    const parsed = JSON.parse(row.actionable_issue_kinds) as unknown;
    if (Array.isArray(parsed)) {
      kinds = parsed.filter((kind): kind is ActionableIssueKind =>
        kind === 'bug' || kind === 'feature' || kind === 'docs' || kind === 'chore',
      );
    }
  } catch {
    // A malformed hand-edited row fails closed: no issue is auto-admitted.
  }
  return {
    workspaceId: row.workspace_id,
    repo: row.repo,
    mode: row.mode === 'autonomous' || row.mode === 'governed' ? row.mode : 'off',
    actionableIssueKinds: kinds,
    queueIssues: row.queue_issues === 1,
    autoApplyTriage: row.auto_apply_triage === 1,
    mergeMethod:
      row.merge_method === 'merge' || row.merge_method === 'rebase' ? row.merge_method : 'squash',
    maxAttempts: Math.min(10, Math.max(1, row.max_attempts)),
    ownerId: row.owner_id,
    updatedAt: row.updated_at,
    // An empty string is not a label. Treating it as one would make the gate
    // unsatisfiable rather than absent, which is the wrong failure: the flow
    // would go silent with no refusal to read.
    admitLabel: typeof row.admit_label === 'string' && row.admit_label !== '' ? row.admit_label : null,
  };
}
