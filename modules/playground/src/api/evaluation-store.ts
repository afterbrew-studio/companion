import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  PlaygroundEvaluationCaseInput,
  PlaygroundEvaluationCaseRecord,
  PlaygroundEvaluationCheck,
  PlaygroundEvaluationExpectation,
  PlaygroundEvaluationRun,
  PlaygroundProductionEvaluationRun,
  PlaygroundProductionEvaluationSuite,
  PlaygroundProductionRunConfiguration,
  PlaygroundProductionSuiteBudget,
} from '../contract/index.js';

interface CaseRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  repo: string | null;
  workspace_id: string | null;
  owner_id: string;
  skill: string | null;
  timeout_ms: number;
  tags: string;
  safety_critical: number;
  expectation: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  case_id: string;
  case_name: string;
  case_revision: number;
  prompt_version: number;
  run_id: string | null;
  status: string;
  checks: string;
  message: string | null;
  error: string | null;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  created_at: number;
}

interface ProductionRunRow {
  id: string;
  case_id: string;
  case_name: string;
  case_revision: number;
  adapter_id: string;
  adapter_version: number;
  prompt_fingerprint: string;
  run_id: string | null;
  status: string;
  checks: string;
  parsed_output: string | null;
  message: string | null;
  error: string | null;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  configuration: string;
  owner_id: string;
  created_at: number;
}

interface ProductionSuiteRow {
  id: string;
  owner_id: string;
  status: string;
  total: number;
  completed: number;
  current_case_id: string | null;
  current_case_name: string | null;
  case_ids: string;
  budget: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const DEFAULT_EXPECTATION: PlaygroundEvaluationExpectation = {
  responseFormat: 'text',
  requiredPhrases: [],
  forbiddenPhrases: [],
  requiredJsonPaths: [],
  expectedJson: {},
  maxDurationMs: null,
  maxInputTokens: null,
  maxOutputTokens: null,
};

const EMPTY_PRODUCTION_SUITE_BUDGET: PlaygroundProductionSuiteBudget = {
  startedAt: 0,
  deadlineAt: 0,
  maxTokens: 1_000_000,
  inputTokens: 0,
  outputTokens: 0,
  reportedRuns: 0,
  missingRuns: 0,
  estimatedCostUsd: 0,
  costPartial: false,
};

/** Durable, bounded corpus and run history for the Playground evaluation bench. */
export class PlaygroundEvaluationStore {
  constructor(private readonly db: Database) {}

  insertCase(record: PlaygroundEvaluationCaseRecord): void {
    this.db
      .prepare(
        `INSERT INTO playground_evaluation_cases (
           id, name, description, prompt, repo, workspace_id, owner_id, skill, timeout_ms,
           tags, safety_critical, expectation, revision, created_at, updated_at
         ) VALUES (
           @id, @name, @description, @prompt, @repo, @workspaceId, @ownerId, @skill, @timeoutMs,
           @tags, @safetyCritical, @expectation, @revision, @createdAt, @updatedAt
         )`,
      )
      .run({
        ...record,
        tags: JSON.stringify(record.tags),
        safetyCritical: record.safetyCritical ? 1 : 0,
        expectation: JSON.stringify(record.expectation),
      });
  }

  updateCase(
    id: string,
    expectedRevision: number,
    input: PlaygroundEvaluationCaseInput,
    scope: { readonly workspaceId: string | null; readonly ownerId: string },
  ): PlaygroundEvaluationCaseRecord | null {
    const changed = this.db
      .prepare(
        `UPDATE playground_evaluation_cases SET
           name = @name, description = @description, prompt = @prompt, repo = @repo,
           workspace_id = @workspaceId, owner_id = @ownerId, skill = @skill,
           timeout_ms = @timeoutMs, tags = @tags, safety_critical = @safetyCritical,
           expectation = @expectation, revision = revision + 1, updated_at = @updatedAt
         WHERE id = @id AND revision = @expectedRevision`,
      )
      .run({
        id,
        expectedRevision,
        ...input,
        ...scope,
        tags: JSON.stringify(input.tags),
        safetyCritical: input.safetyCritical ? 1 : 0,
        expectation: JSON.stringify(input.expectation),
        updatedAt: Date.now(),
      }).changes;
    return changed > 0 ? (this.getCase(id) ?? null) : null;
  }

  getCase(id: string): PlaygroundEvaluationCaseRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM playground_evaluation_cases WHERE id = ?`).get(id) as CaseRow | undefined;
    return row ? rowToCase(row) : undefined;
  }

  listCases(ownerId: string, workspaceIds: ReadonlySet<string>): PlaygroundEvaluationCaseRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM playground_evaluation_cases
         WHERE owner_id = @ownerId
            OR workspace_id IN (SELECT value FROM json_each(@workspaceIds))
         ORDER BY updated_at DESC
         LIMIT 200`,
      )
      .all({ ownerId, workspaceIds: JSON.stringify([...workspaceIds]) }) as CaseRow[];
    return rows.map(rowToCase);
  }

  listRuns(ownerId: string, workspaceIds: ReadonlySet<string>): PlaygroundEvaluationRun[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM playground_evaluation_runs r
         JOIN playground_evaluation_cases c ON c.id = r.case_id
         WHERE c.owner_id = @ownerId
            OR c.workspace_id IN (SELECT value FROM json_each(@workspaceIds))
         ORDER BY r.created_at DESC
         LIMIT 200`,
      )
      .all({ ownerId, workspaceIds: JSON.stringify([...workspaceIds]) }) as RunRow[];
    return rows.map(rowToRun);
  }

  deleteCase(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM playground_evaluation_runs WHERE case_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM playground_evaluation_cases WHERE id = ?`).run(id).changes > 0;
    })();
  }

  insertRun(run: PlaygroundEvaluationRun, caseSnapshot: PlaygroundEvaluationCaseRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO playground_evaluation_runs (
             id, case_id, case_name, case_revision, prompt_version, case_snapshot, run_id, status, checks,
             message, error, duration_ms, input_tokens, output_tokens, model, created_at
           ) VALUES (
             @id, @caseId, @caseName, @caseRevision, @promptVersion, @caseSnapshot, @runId, @status, @checks,
             @message, @error, @durationMs, @inputTokens, @outputTokens, @model, @createdAt
           )`,
        )
        .run({
          ...run,
          caseSnapshot: JSON.stringify(caseSnapshot),
          checks: JSON.stringify(run.checks),
          message: run.message?.slice(0, 64_000) ?? null,
        });
      // Keep comparisons useful without turning every exploratory replay into
      // an unbounded second transcript store. The operate run remains canonical.
      this.db
        .prepare(
          `DELETE FROM playground_evaluation_runs
           WHERE case_id = ? AND id NOT IN (
             SELECT id FROM playground_evaluation_runs
             WHERE case_id = ? ORDER BY created_at DESC LIMIT 50
           )`,
        )
        .run(run.caseId, run.caseId);
    })();
  }

  listProductionRuns(ownerId: string): PlaygroundProductionEvaluationRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM playground_production_evaluation_runs
         WHERE owner_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 500`,
      )
      .all(ownerId) as ProductionRunRow[];
    return rows.map(rowToProductionRun);
  }

  insertProductionRun(run: PlaygroundProductionEvaluationRun): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO playground_production_evaluation_runs (
             id, case_id, case_name, case_revision, adapter_id, adapter_version, prompt_fingerprint, run_id,
             status, checks, parsed_output, message, error, duration_ms, input_tokens,
             output_tokens, model, configuration, owner_id, created_at
           ) VALUES (
             @id, @caseId, @caseName, @caseRevision, @adapterId, @adapterVersion, @promptFingerprint, @runId,
             @status, @checks, @parsedOutput, @message, @error, @durationMs, @inputTokens,
             @outputTokens, @model, @configuration, @ownerId, @createdAt
           )`,
        )
        .run({
          ...run,
          checks: JSON.stringify(run.checks),
          parsedOutput: boundedJson(run.parsedOutput),
          message: run.message?.slice(0, 64_000) ?? null,
          configuration: JSON.stringify(run.configuration),
        });
      this.db
        .prepare(
          `DELETE FROM playground_production_evaluation_runs
           WHERE owner_id = @ownerId AND case_id = @caseId AND id NOT IN (
             SELECT id FROM playground_production_evaluation_runs
             WHERE owner_id = @ownerId AND case_id = @caseId
             ORDER BY created_at DESC, rowid DESC LIMIT 50
           )`,
        )
        .run({ ownerId: run.ownerId, caseId: run.caseId });
    })();
  }

  insertProductionSuite(suite: PlaygroundProductionEvaluationSuite): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO playground_production_evaluation_suites (
             id, owner_id, status, total, completed, current_case_id,
             current_case_name, case_ids, budget, error, created_at, updated_at
           ) VALUES (
             @id, @ownerId, @status, @total, @completed, @currentCaseId,
             @currentCaseName, @caseIds, @budget, @error, @createdAt, @updatedAt
           )`,
        )
        .run({ ...suite, caseIds: JSON.stringify(suite.caseIds), budget: JSON.stringify(suite.budget) });
      this.db
        .prepare(
          `DELETE FROM playground_production_evaluation_suites
           WHERE owner_id = ? AND status <> 'running' AND id NOT IN (
             SELECT id FROM playground_production_evaluation_suites
             WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50
           )`,
        )
        .run(suite.ownerId, suite.ownerId);
    })();
  }

  getProductionSuite(id: string): PlaygroundProductionEvaluationSuite | null {
    const row = this.db
      .prepare(`SELECT * FROM playground_production_evaluation_suites WHERE id = ?`)
      .get(id) as ProductionSuiteRow | undefined;
    return row ? rowToProductionSuite(row) : null;
  }

  listProductionSuites(ownerId: string): PlaygroundProductionEvaluationSuite[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM playground_production_evaluation_suites
         WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      )
      .all(ownerId) as ProductionSuiteRow[];
    return rows.map(rowToProductionSuite);
  }

  updateProductionSuiteProgress(
    id: string,
    completed: number,
    currentCaseId: string | null,
    currentCaseName: string | null,
  ): boolean {
    return this.db
      .prepare(
        `UPDATE playground_production_evaluation_suites SET
           completed = ?, current_case_id = ?, current_case_name = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(completed, currentCaseId, currentCaseName, Date.now(), id).changes > 0;
  }

  updateProductionSuiteBudget(id: string, budget: PlaygroundProductionSuiteBudget): boolean {
    return this.db
      .prepare(
        `UPDATE playground_production_evaluation_suites SET budget = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(budget), Date.now(), id).changes > 0;
  }

  finishProductionSuite(
    id: string,
    status: Exclude<PlaygroundProductionEvaluationSuite['status'], 'running'>,
    error: string | null,
  ): boolean {
    return this.db
      .prepare(
        `UPDATE playground_production_evaluation_suites SET
           status = ?, current_case_id = NULL, current_case_name = NULL,
           error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, error, Date.now(), id).changes > 0;
  }

  recoverProductionSuites(): number {
    return this.db
      .prepare(
        `UPDATE playground_production_evaluation_suites SET
           status = 'interrupted', current_case_id = NULL, current_case_name = NULL,
           error = 'Companion restarted while this release gate was running; start it again.',
           updated_at = ?
         WHERE status = 'running'`,
      )
      .run(Date.now()).changes;
  }
}

function rowToCase(row: CaseRow): PlaygroundEvaluationCaseRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    repo: row.repo,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    skill: row.skill,
    timeoutMs: row.timeout_ms,
    tags: safeParse<string[]>(row.tags, []),
    safetyCritical: !!row.safety_critical,
    expectation: safeParse<PlaygroundEvaluationExpectation>(row.expectation, DEFAULT_EXPECTATION),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: RunRow): PlaygroundEvaluationRun {
  return {
    id: row.id,
    caseId: row.case_id,
    caseName: row.case_name,
    caseRevision: row.case_revision,
    promptVersion: row.prompt_version,
    runId: row.run_id,
    status: row.status as PlaygroundEvaluationRun['status'],
    checks: safeParse<PlaygroundEvaluationCheck[]>(row.checks, []),
    message: row.message,
    error: row.error,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    model: row.model,
    createdAt: row.created_at,
  };
}

const EMPTY_PRODUCTION_CONFIGURATION: PlaygroundProductionRunConfiguration = {
  fingerprint: '',
  task: '',
  taskModelPin: null,
  laneRunnerId: null,
  laneHarness: null,
  laneTaskModel: null,
  laneDefaultModel: null,
  daemonDefaultModel: null,
  actualModel: null,
  actualRunnerId: null,
  actualHarness: null,
};

function rowToProductionRun(row: ProductionRunRow): PlaygroundProductionEvaluationRun {
  return {
    id: row.id,
    caseId: row.case_id,
    caseName: row.case_name,
    caseRevision: row.case_revision,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    promptFingerprint: row.prompt_fingerprint,
    runId: row.run_id,
    status: row.status as PlaygroundProductionEvaluationRun['status'],
    checks: safeParse<PlaygroundEvaluationCheck[]>(row.checks, []),
    parsedOutput: row.parsed_output === null ? null : safeParse<unknown>(row.parsed_output, null),
    message: row.message,
    error: row.error,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    model: row.model,
    configuration: safeParse<PlaygroundProductionRunConfiguration>(
      row.configuration,
      EMPTY_PRODUCTION_CONFIGURATION,
    ),
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

function boundedJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return JSON.stringify({ unavailable: true });
    return encoded.length <= 64_000 ? encoded : JSON.stringify({ truncated: true, characters: encoded.length });
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

function rowToProductionSuite(row: ProductionSuiteRow): PlaygroundProductionEvaluationSuite {
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status as PlaygroundProductionEvaluationSuite['status'],
    total: row.total,
    completed: row.completed,
    currentCaseId: row.current_case_id,
    currentCaseName: row.current_case_name,
    caseIds: safeParse<string[]>(row.case_ids, []),
    budget: safeParse<PlaygroundProductionSuiteBudget>(row.budget, EMPTY_PRODUCTION_SUITE_BUDGET),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
