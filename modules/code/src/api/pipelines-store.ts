import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  PipelineRecord,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepLog,
  PipelineStepResult,
  PipelineStepSpec,
  PipelineTrigger,
  StepDefinitionRecord,
} from '../contract/index.js';

/** Pipeline definitions, the custom step library, and pipeline run history. */
export class PipelinesStore {
  constructor(private readonly db: Database) {}

  insert(p: PipelineRecord): void {
    this.db
      .prepare(
        `INSERT INTO pipelines (id, workspace_id, type, name, description, steps, auto_run, auto_update, created_at, updated_at)
         VALUES (@id, @workspaceId, @type, @name, @description, @steps, @autoRun, @autoUpdate, @createdAt, @updatedAt)`,
      )
      .run({
        id: p.id,
        workspaceId: p.workspaceId,
        type: p.type,
        name: p.name,
        description: p.description,
        steps: JSON.stringify(p.steps),
        autoRun: p.autoRunOnPrOpen ? 1 : 0,
        autoUpdate: p.autoRunOnPrUpdate ? 1 : 0,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
  }

  update(
    id: string,
    fields: {
      type?: string;
      name?: string;
      description?: string;
      steps?: ReadonlyArray<PipelineStepSpec>;
      autoRunOnPrOpen?: boolean;
      autoRunOnPrUpdate?: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE pipelines SET
           type = COALESCE(@type, type),
           name = COALESCE(@name, name),
           description = COALESCE(@description, description),
           steps = COALESCE(@steps, steps),
           auto_run = COALESCE(@autoRun, auto_run),
           auto_update = COALESCE(@autoUpdate, auto_update),
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        type: fields.type ?? null,
        name: fields.name ?? null,
        description: fields.description ?? null,
        steps: fields.steps ? JSON.stringify(fields.steps) : null,
        autoRun: fields.autoRunOnPrOpen === undefined ? null : fields.autoRunOnPrOpen ? 1 : 0,
        autoUpdate: fields.autoRunOnPrUpdate === undefined ? null : fields.autoRunOnPrUpdate ? 1 : 0,
        updatedAt: Date.now(),
      });
  }

  get(id: string): PipelineRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipelines WHERE id = ?`).get(id) as PipelineRow | undefined;
    return row ? pipelineRowToRecord(row) : undefined;
  }

  list(workspaceId: string): PipelineRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY name`)
      .all(workspaceId) as PipelineRow[];
    return rows.map(pipelineRowToRecord);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  }

  /** Workspace-delete cleanup: every pipeline and library step the workspace owns. */
  deleteByWorkspace(workspaceId: string): void {
    this.db.prepare(`DELETE FROM pipelines WHERE workspace_id = ?`).run(workspaceId);
    this.db.prepare(`DELETE FROM step_definitions WHERE workspace_id = ?`).run(workspaceId);
  }

  // ---------- step definitions (custom step library) --------------------------------

  insertStepDefinition(d: StepDefinitionRecord): void {
    this.db
      .prepare(
        `INSERT INTO step_definitions (id, workspace_id, name, description, step, created_at, updated_at)
         VALUES (@id, @workspaceId, @name, @description, @step, @createdAt, @updatedAt)`,
      )
      .run({
        id: d.id,
        workspaceId: d.workspaceId,
        name: d.name,
        description: d.description,
        step: JSON.stringify(d.step),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
  }

  updateStepDefinition(
    id: string,
    fields: { name?: string; description?: string; step?: PipelineStep },
  ): void {
    this.db
      .prepare(
        `UPDATE step_definitions SET
           name = COALESCE(@name, name),
           description = COALESCE(@description, description),
           step = COALESCE(@step, step),
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        name: fields.name ?? null,
        description: fields.description ?? null,
        step: fields.step ? JSON.stringify(fields.step) : null,
        updatedAt: Date.now(),
      });
  }

  getStepDefinition(id: string): StepDefinitionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM step_definitions WHERE id = ?`).get(id) as
      | StepDefinitionRow
      | undefined;
    return row ? stepDefinitionRowToRecord(row) : undefined;
  }

  /** Every workspace that owns a pipeline or a library step. Used by the
   *  secret sweep, which has to see all of them, not one workspace's. */
  workspaceIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT workspace_id FROM pipelines
         UNION SELECT workspace_id FROM step_definitions`,
      )
      .all() as { workspace_id: string }[];
    return rows.map((r) => r.workspace_id);
  }

  listStepDefinitions(workspaceId: string): StepDefinitionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM step_definitions WHERE workspace_id = ? ORDER BY name`)
      .all(workspaceId) as StepDefinitionRow[];
    return rows.map(stepDefinitionRowToRecord).filter((d): d is StepDefinitionRecord => d !== undefined);
  }

  deleteStepDefinition(id: string): void {
    this.db.prepare(`DELETE FROM step_definitions WHERE id = ?`).run(id);
  }

  // ---------- pipeline runs -----------------------------------------------------------

  insertRun(r: PipelineRunRecord, idempotencyKey: string | null = null): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO pipeline_runs
           (id, pipeline_id, owner_id, workspace_id, pipeline_name, target, repo, pr_number, status, trigger, steps, created_at, finished_at, idempotency_key)
         VALUES
           (@id, @pipelineId, @ownerId, @workspaceId, @pipelineName, @target, @repo, @prNumber, @status, @trigger, @steps, @createdAt, @finishedAt, @idempotencyKey)`,
      )
      .run({
        id: r.id,
        pipelineId: r.pipelineId,
        ownerId: r.ownerId,
        workspaceId: r.workspaceId,
        pipelineName: r.pipelineName,
        target: r.target,
        repo: r.repo,
        prNumber: r.prNumber,
        status: r.status,
        trigger: r.trigger,
        steps: JSON.stringify(r.steps),
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        idempotencyKey,
      });
    return result.changes === 1;
  }

  getRunByIdempotencyKey(key: string): PipelineRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_runs WHERE idempotency_key = ?`).get(key) as
      | PipelineRunRow
      | undefined;
    return row ? pipelineRunRowToRecord(row) : undefined;
  }

  /** Update only while the run is live; a late step must never revive a terminal row. */
  updateRunningRun(
    id: string,
    fields: {
      status?: PipelineRunStatus;
      steps?: ReadonlyArray<PipelineStepResult>;
      finishedAt?: number | null;
    },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_runs SET
           status = COALESCE(@status, status),
           steps = COALESCE(@steps, steps),
           finished_at = COALESCE(@finishedAt, finished_at)
         WHERE id = @id AND status = 'running'`,
      )
      .run({
        id,
        status: fields.status ?? null,
        steps: fields.steps ? JSON.stringify(fields.steps) : null,
        finishedAt: fields.finishedAt ?? null,
      });
    return result.changes === 1;
  }

  getRun(id: string): PipelineRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as
      | PipelineRunRow
      | undefined;
    return row ? pipelineRunRowToRecord(row, true) : undefined;
  }

  /** Scope-only lookup for hot authorization paths; never parses the steps blob. */
  getRunScope(id: string): { readonly repo: string } | undefined {
    return this.db.prepare(`SELECT repo FROM pipeline_runs WHERE id = ?`).get(id) as
      | { readonly repo: string }
      | undefined;
  }

  /** Undefined means no such step; null is a real step that emitted no log. */
  getStepLog(id: string, stepIndex: number): PipelineStepLog | null | undefined {
    const row = this.db.prepare(`SELECT steps FROM pipeline_runs WHERE id = ?`).get(id) as
      | Pick<PipelineRunRow, 'steps'>
      | undefined;
    if (!row) return undefined;
    const steps = safeParse<PipelineStepResult[]>(row.steps, []);
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) return undefined;
    const step = steps[stepIndex];
    return step?.log ?? null;
  }

  listRunsForIssue(repo: string, issueNumber: number, limit = 50): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE repo = ? AND pr_number = ? AND target = 'issue' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repo, issueNumber, limit) as PipelineRunRow[];
    return rows.map((row) => pipelineRunRowToRecord(row));
  }

  listRunsForPr(repo: string, prNumber: number, limit = 50): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE repo = ? AND pr_number = ? AND target = 'pr' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repo, prNumber, limit) as PipelineRunRow[];
    return rows.map((row) => pipelineRunRowToRecord(row));
  }

  listWorkspaceRuns(workspaceId: string, limit = 100): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as PipelineRunRow[];
    return rows.map((row) => pipelineRunRowToRecord(row));
  }

  /** Persist cancellation first; active work is stopped only after this CAS wins. */
  cancelRun(
    id: string,
    reason: string,
    latestSteps?: ReadonlyArray<PipelineStepResult>,
  ): PipelineRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as PipelineRunRow | undefined;
    if (!row || row.status !== 'running') return row ? pipelineRunRowToRecord(row, true) : undefined;
    const now = Date.now();
    const steps = cancelledSteps(latestSteps ?? safeParse<PipelineStepResult[]>(row.steps, []), reason, now);
    this.db
      .prepare(
        `UPDATE pipeline_runs
            SET status = 'cancelled', steps = ?, finished_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(steps), now, id);
    return this.getRun(id);
  }

  /** Terminalize a run when the engine itself throws outside a step handler. */
  failRun(
    id: string,
    reason: string,
    latestSteps?: ReadonlyArray<PipelineStepResult>,
  ): PipelineRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as PipelineRunRow | undefined;
    if (!row || row.status !== 'running') return row ? pipelineRunRowToRecord(row, true) : undefined;
    const now = Date.now();
    const steps = interruptedSteps(latestSteps ?? safeParse<PipelineStepResult[]>(row.steps, []), reason, now);
    this.db
      .prepare(`UPDATE pipeline_runs SET status = 'error', steps = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(JSON.stringify(steps), now, id);
    return this.getRun(id);
  }

  /** Boot sweep: runs left 'running' by a dead daemon are errors. */
  markInterruptedRuns(): number {
    const rows = this.db.prepare(`SELECT * FROM pipeline_runs WHERE status = 'running'`).all() as PipelineRunRow[];
    const finish = this.db.prepare(
      `UPDATE pipeline_runs SET status = 'error', steps = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
    );
    const now = Date.now();
    const sweep = this.db.transaction(() => {
      let changed = 0;
      for (const row of rows) {
        const steps = interruptedSteps(safeParse<PipelineStepResult[]>(row.steps, []), 'daemon restarted during this run', now);
        changed += finish.run(JSON.stringify(steps), now, row.id).changes;
      }
      return changed;
    });
    return sweep();
  }
}

interface PipelineRow {
  id: string;
  workspace_id: string;
  type: string;
  name: string;
  description: string;
  steps: string;
  auto_run: number;
  auto_update: number;
  created_at: number;
  updated_at: number;
}

interface StepDefinitionRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  step: string;
  created_at: number;
  updated_at: number;
}

interface PipelineRunRow {
  id: string;
  pipeline_id: string;
  owner_id: string | null;
  workspace_id: string | null;
  pipeline_name: string;
  target: string;
  repo: string;
  pr_number: number;
  status: PipelineRunStatus;
  trigger: PipelineTrigger;
  steps: string;
  created_at: number;
  finished_at: number | null;
}

function pipelineRowToRecord(row: PipelineRow): PipelineRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type === 'issue' || row.type === 'platform' ? row.type : 'pr',
    name: row.name,
    description: row.description,
    steps: safeParse<PipelineStepSpec[]>(row.steps, []),
    autoRunOnPrOpen: row.auto_run === 1,
    autoRunOnPrUpdate: row.auto_update === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stepDefinitionRowToRecord(row: StepDefinitionRow): StepDefinitionRecord | undefined {
  const step = safeParse<PipelineStep | null>(row.step, null);
  if (!step) return undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pipelineRunRowToRecord(row: PipelineRunRow, includeEvidence = false): PipelineRunRecord {
  const steps = safeParse<PipelineStepResult[]>(row.steps, []);
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    pipelineName: row.pipeline_name,
    target: row.target === 'issue' || row.target === 'platform' ? row.target : 'pr',
    repo: row.repo,
    prNumber: row.pr_number,
    status: row.status,
    trigger: row.trigger,
    // List feeds stay small even when old command/review-heavy runs are
    // retained. One explicitly opened run loads its complete evidence.
    steps: includeEvidence
      ? steps
      : steps.map(({ log: _log, detail: _detail, ...step }) => ({ ...step, detail: null })),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function cancelledSteps(
  steps: readonly PipelineStepResult[],
  reason: string,
  now: number,
): PipelineStepResult[] {
  return steps.map((step) => {
    if (step.status === 'running' || step.status === 'awaiting') {
      return { ...step, status: 'cancelled', summary: reason, finishedAt: now };
    }
    if (step.status === 'pending') {
      return { ...step, status: 'skipped', summary: 'not run because the pipeline was cancelled', finishedAt: now };
    }
    return step;
  });
}

function interruptedSteps(
  steps: readonly PipelineStepResult[],
  reason: string,
  now: number,
): PipelineStepResult[] {
  return steps.map((step) => {
    if (step.status === 'running' || step.status === 'awaiting') {
      return { ...step, status: 'error', summary: reason, finishedAt: now };
    }
    if (step.status === 'pending') {
      return { ...step, status: 'skipped', summary: 'not run because the pipeline was interrupted', finishedAt: now };
    }
    return step;
  });
}
