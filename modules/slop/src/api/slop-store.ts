import type { Database } from 'better-sqlite3';
import { safeParse } from '@companion/services';
import type { SlopAppliedAction, SlopDetectionResult, SlopRuleRecord, SlopVerdict } from '../contract/index.js';

interface DetectionRow {
  id: string;
  repo: string;
  pr_number: number;
  pr_title: string;
  run_id: string;
  status: string;
  verdict: string | null;
  error: string | null;
  applied_action: string | null;
  rule_ids: string;
  created_at: number;
}

interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToDetection(row: DetectionRow): SlopDetectionResult {
  const verdict = row.verdict ? safeParse<SlopVerdict | null>(row.verdict, null) : null;
  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    runId: row.run_id,
    status: row.status as SlopDetectionResult['status'],
    // reviewerHints post-dates the first verdicts; old JSON normalizes to [].
    verdict: verdict ? { ...verdict, reviewerHints: verdict.reviewerHints ?? [] } : null,
    error: row.error,
    appliedAction: row.applied_action as SlopAppliedAction | null,
    ruleIds: safeParse<string[]>(row.rule_ids, []),
    createdAt: row.created_at,
  };
}

function rowToRule(row: RuleRow): SlopRuleRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    builtin: false,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Acted-on detections older than this are swept on insert (pending ones are kept). */
const DETECTION_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Owner of the slop_detections / slop_rules / slop_builtin_toggles tables. */
export class SlopStore {
  constructor(private readonly db: Database) {}

  // ---------- detections ------------------------------------------------------------

  insertDetection(d: SlopDetectionResult): void {
    this.db
      .prepare(
        `INSERT INTO slop_detections (
           id, repo, pr_number, pr_title, run_id, status, verdict, error, applied_action, rule_ids, created_at
         ) VALUES (
           @id, @repo, @prNumber, @prTitle, @runId, @status, @verdict, @error, @appliedAction, @ruleIds, @createdAt
         )`,
      )
      .run({
        ...d,
        verdict: d.verdict ? JSON.stringify(d.verdict) : null,
        ruleIds: JSON.stringify(d.ruleIds),
      });
    // Bounded retention: re-detections accumulate per PR; old settled rows go.
    this.db
      .prepare(`DELETE FROM slop_detections WHERE created_at < ? AND status NOT IN ('pending', 'running')`)
      .run(Date.now() - DETECTION_RETENTION_MS);
  }

  /**
   * Settle a 'running' placeholder with the agent phase's outcome. The verdict
   * fields are guarded on status so a dismissal that raced the run wins, but
   * the run id always lands — the executed run stays linkable either way.
   * Returns whether the row was still ours to settle.
   */
  finishDetection(
    id: string,
    fields: { runId: string; status: 'pending' | 'failed'; verdict: SlopVerdict | null; error: string | null },
  ): boolean {
    if (fields.runId) this.db.prepare(`UPDATE slop_detections SET run_id = ? WHERE id = ?`).run(fields.runId, id);
    return (
      this.db
        .prepare(`UPDATE slop_detections SET status = ?, verdict = ?, error = ? WHERE id = ? AND status = 'running'`)
        .run(fields.status, fields.verdict ? JSON.stringify(fields.verdict) : null, fields.error, id)
        .changes > 0
    );
  }

  /**
   * First-activation sweep: any row still 'running' belongs to a process that
   * no longer exists — fail it honestly (a durably-queued detection replays as
   * its own fresh row).
   */
  failInterrupted(): number {
    return this.db
      .prepare(`UPDATE slop_detections SET status = 'failed', error = ? WHERE status = 'running'`)
      .run('interrupted before the run finished').changes;
  }

  getDetection(id: string): SlopDetectionResult | undefined {
    const row = this.db.prepare(`SELECT * FROM slop_detections WHERE id = ?`).get(id) as DetectionRow | undefined;
    return row ? rowToDetection(row) : undefined;
  }

  setDetectionStatus(id: string, status: SlopDetectionResult['status'], appliedAction: SlopAppliedAction | null): void {
    this.db
      .prepare(`UPDATE slop_detections SET status = ?, applied_action = ? WHERE id = ?`)
      .run(status, appliedAction, id);
  }

  /**
   * One workspace's detections, newest first. Workspace scoping goes through
   * code's published `v_repos` view — never a raw JOIN on its repos table.
   */
  listByWorkspace(workspaceId: string, limit = 100): SlopDetectionResult[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM slop_detections d JOIN v_repos r ON r.full_name = d.repo
         WHERE r.workspace_id = ? ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as DetectionRow[];
    return rows.map(rowToDetection);
  }

  /** A PR's detection history, newest first. */
  listForPr(repo: string, prNumber: number): SlopDetectionResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM slop_detections WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC`)
      .all(repo, prNumber) as DetectionRow[];
    return rows.map(rowToDetection);
  }

  // ---------- rules (user-defined; built-ins live in builtin-rules.ts) --------------

  insertRule(rule: SlopRuleRecord & { workspaceId: string }): void {
    this.db
      .prepare(
        `INSERT INTO slop_rules (id, workspace_id, name, description, instructions, enabled, created_at, updated_at)
         VALUES (@id, @workspaceId, @name, @description, @instructions, @enabled, @createdAt, @updatedAt)`,
      )
      .run({
        id: rule.id,
        workspaceId: rule.workspaceId,
        name: rule.name,
        description: rule.description,
        instructions: rule.instructions,
        enabled: rule.enabled ? 1 : 0,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
  }

  updateRule(id: string, fields: { name?: string; description?: string; instructions?: string }): void {
    const existing = this.getRule(id);
    if (!existing) return;
    this.db
      .prepare(`UPDATE slop_rules SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?`)
      .run(
        fields.name ?? existing.name,
        fields.description ?? existing.description,
        fields.instructions ?? existing.instructions,
        Date.now(),
        id,
      );
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE slop_rules SET enabled = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, Date.now(), id);
  }

  deleteRule(id: string): boolean {
    return this.db.prepare(`DELETE FROM slop_rules WHERE id = ?`).run(id).changes > 0;
  }

  getRule(id: string): SlopRuleRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM slop_rules WHERE id = ?`).get(id) as RuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  listRules(workspaceId: string): SlopRuleRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM slop_rules WHERE workspace_id = ? ORDER BY created_at`)
      .all(workspaceId) as RuleRow[];
    return rows.map(rowToRule);
  }

  // ---------- built-in toggles ------------------------------------------------------

  /** Built-in rule ids disabled for this workspace (absence of a row = enabled). */
  disabledBuiltins(workspaceId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT rule_id FROM slop_builtin_toggles WHERE workspace_id = ? AND enabled = 0`)
      .all(workspaceId) as Array<{ rule_id: string }>;
    return new Set(rows.map((r) => r.rule_id));
  }

  setBuiltinEnabled(workspaceId: string, ruleId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO slop_builtin_toggles (workspace_id, rule_id, enabled) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, rule_id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(workspaceId, ruleId, enabled ? 1 : 0);
  }
}
