import type Database from 'better-sqlite3';
import type {
  PipelineRecord,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepResult,
  PipelineStepSpec,
  PipelineTrigger,
  StepDefinitionRecord,
} from '@companion/contract';
import { safeParse } from './util.js';

/** Pipeline definitions, the custom step library, and pipeline run history. */
export class PipelinesStore {
  constructor(private readonly db: Database.Database) {}

  insert(p: PipelineRecord): void {
    this.db
      .prepare(
        `INSERT INTO pipelines (id, workspace_id, type, name, description, steps, auto_run, created_at, updated_at)
         VALUES (@id, @workspaceId, @type, @name, @description, @steps, @autoRun, @createdAt, @updatedAt)`,
      )
      .run({
        id: p.id,
        workspaceId: p.workspaceId,
        type: p.type,
        name: p.name,
        description: p.description,
        steps: JSON.stringify(p.steps),
        autoRun: p.autoRunOnPrOpen ? 1 : 0,
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

  insertRun(r: PipelineRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, pipeline_id, pipeline_name, target, repo, pr_number, status, trigger, steps, created_at, finished_at)
         VALUES (@id, @pipelineId, @pipelineName, @target, @repo, @prNumber, @status, @trigger, @steps, @createdAt, @finishedAt)`,
      )
      .run({
        id: r.id,
        pipelineId: r.pipelineId,
        pipelineName: r.pipelineName,
        target: r.target,
        repo: r.repo,
        prNumber: r.prNumber,
        status: r.status,
        trigger: r.trigger,
        steps: JSON.stringify(r.steps),
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      });
  }

  updateRun(
    id: string,
    fields: {
      status?: PipelineRunStatus;
      steps?: ReadonlyArray<PipelineStepResult>;
      finishedAt?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE pipeline_runs SET
           status = COALESCE(@status, status),
           steps = COALESCE(@steps, steps),
           finished_at = COALESCE(@finishedAt, finished_at)
         WHERE id = @id`,
      )
      .run({
        id,
        status: fields.status ?? null,
        steps: fields.steps ? JSON.stringify(fields.steps) : null,
        finishedAt: fields.finishedAt ?? null,
      });
  }

  getRun(id: string): PipelineRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as
      | PipelineRunRow
      | undefined;
    return row ? pipelineRunRowToRecord(row) : undefined;
  }

  listRunsForIssue(repo: string, issueNumber: number, limit = 50): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE repo = ? AND pr_number = ? AND target = 'issue' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repo, issueNumber, limit) as PipelineRunRow[];
    return rows.map(pipelineRunRowToRecord);
  }

  listRunsForPr(repo: string, prNumber: number, limit = 50): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE repo = ? AND pr_number = ? AND target = 'pr' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repo, prNumber, limit) as PipelineRunRow[];
    return rows.map(pipelineRunRowToRecord);
  }

  listWorkspaceRuns(workspaceId: string, limit = 100): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT pr.* FROM pipeline_runs pr JOIN repos r ON r.full_name = pr.repo
         WHERE r.workspace_id = ? ORDER BY pr.created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as PipelineRunRow[];
    return rows.map(pipelineRunRowToRecord);
  }

  /** Boot sweep: runs left 'running' by a dead daemon are errors. */
  markInterruptedRuns(): number {
    const result = this.db
      .prepare(`UPDATE pipeline_runs SET status = 'error', finished_at = ? WHERE status = 'running'`)
      .run(Date.now());
    return result.changes;
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

function pipelineRunRowToRecord(row: PipelineRunRow): PipelineRunRecord {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    pipelineName: row.pipeline_name,
    target: row.target === 'issue' || row.target === 'platform' ? row.target : 'pr',
    repo: row.repo,
    prNumber: row.pr_number,
    status: row.status,
    trigger: row.trigger,
    steps: safeParse<PipelineStepResult[]>(row.steps, []),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
