import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  ClarificationState,
  FeatureBrief,
  FeaturePlanningSession,
  FeaturePlanningSessionSummary,
  PlannerAnswer,
  PlannerEventRecord,
  PlannerQuestion,
  PlannerRevision,
  PlannerUsageRun,
  PlannerUsageSummary,
  RepositoryPlanningContext,
} from '../contract/index.js';
import type { ProposalAnalysis } from '@companion/module-plan/contract';
import { assertPlannerTransition } from './planner-machine.js';
import { emptyClarificationState, plannerProgress } from './planner-progress.js';

export class PlannerRevisionConflict extends Error {
  constructor(readonly current: FeaturePlanningSession) {
    super(`planning session changed (current revision ${current.revision})`);
  }
}

export class PlannerQuestionSetConflict extends Error {
  constructor(readonly current: FeaturePlanningSession) {
    super('these questions are no longer current; open the latest question round before submitting');
  }
}

export type PlannerSessionPatch = Partial<Omit<FeaturePlanningSession, 'id' | 'workspaceId' | 'repo' | 'branch' | 'author' | 'createdAt' | 'updatedAt' | 'revision' | 'progress'>>;

const MAX_EVENTS_PER_SESSION = 500;
const MAX_USAGE_RUNS_IN_DETAIL = 100;

export class PlannerStore {
  constructor(private readonly db: Database) {}

  insert(session: FeaturePlanningSession): void {
    this.db.prepare(`
      INSERT INTO planner_sessions (
        id, workspace_id, repo, branch, target_branch, author, title, idea, step, status, revision,
        active_action, last_error, repository_context_json, clarification_state_json, brief_json, questions_json, answers_json, messages_json,
        artifacts_json, pending_revision_json, confirmations_json, doc_id, spec_id, proposal_id,
        analysis_json, analysis_run_id, refinement_id, task_ids_json, active_queue_id, active_run_id,
        created_at, updated_at
      ) VALUES (
        @id, @workspaceId, @repo, @branch, @targetBranch, @author, @title, @idea, @step, @status, @revision,
        @activeAction, @lastError, @repositoryContext, @clarification, @brief, @questions, @answers, @messages,
        @artifacts, @pendingRevision, @confirmations, @docId, @specId, @proposalId,
        @analysis, @analysisRunId, @refinementId, @taskIds, @activeQueueId, @activeRunId,
        @createdAt, @updatedAt
      )
    `).run({
      ...toParams(session),
      workspaceId: session.workspaceId,
      repo: session.repo,
      branch: session.branch,
      author: session.author,
      createdAt: session.createdAt,
    });
    this.insertEvent(session.id, 'created', { repo: session.repo });
  }

  get(id: string): FeaturePlanningSession | undefined {
    const row = this.db.prepare(`SELECT * FROM planner_sessions WHERE id = ?`).get(id) as PlannerSessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  listByWorkspace(workspaceId: string): FeaturePlanningSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM planner_sessions WHERE workspace_id = ? ORDER BY updated_at DESC`)
      .all(workspaceId) as PlannerSessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Paged list projection: deliberately excludes every large JSON/text column.
   * The small clarification fields are enough to derive the same progress bar
   * as detail without materialising repository context, messages or artifacts.
   */
  listSummariesByWorkspace(
    workspaceId: string,
    limit = 50,
    offset = 0,
  ): { sessions: FeaturePlanningSessionSummary[]; total: number } {
    const safeLimit = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 50, 1), 100);
    const safeOffset = Math.max(Number.isSafeInteger(offset) ? offset : 0, 0);
    const where = `WHERE workspace_id = ? AND status != 'cancelled'`;
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM planner_sessions ${where}`).get(workspaceId) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, repo, title, step, status, active_action,
                clarification_state_json, questions_json, answers_json, updated_at
         FROM planner_sessions ${where}
         ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(workspaceId, safeLimit, safeOffset) as PlannerSessionSummaryRow[];
    return { sessions: rows.map(rowToSummary), total: count.n };
  }

  /** Small bridge used to exclude Ideas-owned proposals from the legacy badge. */
  listProposalIdsByWorkspace(workspaceId: string): string[] {
    return (this.db
      .prepare(`SELECT proposal_id FROM planner_sessions WHERE workspace_id = ? AND proposal_id IS NOT NULL`)
      .all(workspaceId) as Array<{ proposal_id: string }>).map((row) => row.proposal_id);
  }

  countActiveRuns(author: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM planner_sessions WHERE author = ? AND status = 'working' AND active_action IS NOT NULL`)
      .get(author) as { count: number };
    return row.count;
  }

  update(
    id: string,
    patch: PlannerSessionPatch,
    opts: { expectedRevision?: number; event?: string; detail?: Readonly<Record<string, unknown>> } = {},
  ): FeaturePlanningSession {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error('planning session not found');
      if (opts.expectedRevision !== undefined && current.revision !== opts.expectedRevision) {
        throw new PlannerRevisionConflict(current);
      }
      const nextWithoutProgress: Omit<FeaturePlanningSession, 'progress'> = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      const next: FeaturePlanningSession = { ...nextWithoutProgress, progress: plannerProgress(nextWithoutProgress) };
      assertPlannerTransition(current.step, current.status, next.step, next.status);
      const result = this.db.prepare(`
        UPDATE planner_sessions SET
          title = @title, idea = @idea, step = @step, status = @status, revision = @revision,
          target_branch = @targetBranch,
          active_action = @activeAction, last_error = @lastError,
          repository_context_json = @repositoryContext, clarification_state_json = @clarification, brief_json = @brief,
          questions_json = @questions, answers_json = @answers, messages_json = @messages,
          artifacts_json = @artifacts, pending_revision_json = @pendingRevision,
          confirmations_json = @confirmations, doc_id = @docId, spec_id = @specId,
          proposal_id = @proposalId, analysis_json = @analysis, analysis_run_id = @analysisRunId,
          refinement_id = @refinementId, task_ids_json = @taskIds,
          active_queue_id = @activeQueueId, active_run_id = @activeRunId, updated_at = @updatedAt
        WHERE id = @id AND revision = @currentRevision
      `).run({ ...toParams(next), currentRevision: current.revision });
      if (result.changes !== 1) throw new PlannerRevisionConflict(this.get(id) ?? current);
      if (opts.event) this.insertEvent(id, opts.event, opts.detail ?? {});
      return next;
    })();
  }

  listEvents(sessionId: string, limit = 100): PlannerEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM planner_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, Math.min(Math.max(limit, 1), 100)) as PlannerEventRow[];
    return rows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      detail: safeParse<Record<string, unknown>>(row.detail_json, {}),
      createdAt: row.created_at,
    }));
  }

  appendEvent(sessionId: string, kind: string, detail: Readonly<Record<string, unknown>>): void {
    this.insertEvent(sessionId, kind, detail);
  }

  usage(sessionId: string): PlannerUsageSummary {
    const rows = this.db
      .prepare(
        `SELECT detail_json FROM planner_events
         WHERE session_id = ? AND kind = 'planner_run_completed'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, MAX_USAGE_RUNS_IN_DETAIL) as Array<{ detail_json: string }>;
    const runs = rows
      .reverse()
      .map((row) => safeParse<PlannerUsageRun | null>(row.detail_json, null))
      .filter(isUsageRun);
    const totals = this.db
      .prepare(`SELECT * FROM planner_usage_totals WHERE session_id = ?`)
      .get(sessionId) as PlannerUsageTotalsRow | undefined;
    return {
      runs,
      totalRuns: totals?.total_runs ?? runs.length,
      runsTruncated: (totals?.total_runs ?? runs.length) > runs.length,
      totalInputTokens: totals?.total_input_tokens ?? runs.reduce((sum, run) => sum + run.inputTokens, 0),
      totalOutputTokens: totals?.total_output_tokens ?? runs.reduce((sum, run) => sum + run.outputTokens, 0),
      repositoryScanRuns: totals?.repository_scan_runs
        ?? runs.filter((run) => run.contextMode === 'repository_scan').length,
      cachedSnapshotRuns: totals?.cached_snapshot_runs
        ?? runs.filter((run) => run.contextMode === 'cached_snapshot').length,
    };
  }

  /** Boot maintenance for rows created before bounded event retention shipped. */
  compactEvents(): number {
    return this.db
      .prepare(
        `DELETE FROM planner_events WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS event_number
             FROM planner_events
           ) WHERE event_number > ?
         )`,
      )
      .run(MAX_EVENTS_PER_SESSION).changes;
  }

  resetDangling(): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id FROM planner_sessions WHERE status = 'working' OR active_action IS NOT NULL`)
        .all() as Array<{ id: string }>;
      const now = Date.now();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE planner_sessions SET status = 'failed', active_action = NULL,
            active_queue_id = NULL, active_run_id = NULL,
            last_error = 'interrupted by daemon restart — retry this step',
            revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(now, row.id);
        this.insertEvent(row.id, 'recovered', { reason: 'daemon_restart' });
      }
      return rows.length;
    })();
  }

  private insertEvent(sessionId: string, kind: string, detail: Readonly<Record<string, unknown>>): void {
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO planner_events (session_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId, kind, JSON.stringify(detail), Date.now());
      if (kind === 'planner_run_completed' && isUsageRun(detail)) {
        this.db.prepare(`
          INSERT INTO planner_usage_totals (
            session_id, total_runs, total_input_tokens, total_output_tokens,
            repository_scan_runs, cached_snapshot_runs
          ) VALUES (?, 1, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            total_runs = total_runs + 1,
            total_input_tokens = total_input_tokens + excluded.total_input_tokens,
            total_output_tokens = total_output_tokens + excluded.total_output_tokens,
            repository_scan_runs = repository_scan_runs + excluded.repository_scan_runs,
            cached_snapshot_runs = cached_snapshot_runs + excluded.cached_snapshot_runs
        `).run(
          sessionId,
          detail.inputTokens,
          detail.outputTokens,
          detail.contextMode === 'repository_scan' ? 1 : 0,
          detail.contextMode === 'cached_snapshot' ? 1 : 0,
        );
      }
      this.db.prepare(`
        DELETE FROM planner_events
        WHERE session_id = ? AND id < (
          SELECT id FROM planner_events WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
        )
      `).run(sessionId, sessionId, MAX_EVENTS_PER_SESSION - 1);
    })();
  }
}

interface PlannerSessionRow {
  id: string;
  workspace_id: string;
  repo: string;
  branch: string;
  target_branch: string;
  author: string;
  title: string;
  idea: string;
  step: FeaturePlanningSession['step'];
  status: FeaturePlanningSession['status'];
  revision: number;
  active_action: FeaturePlanningSession['activeAction'];
  last_error: string | null;
  repository_context_json: string | null;
  clarification_state_json: string | null;
  brief_json: string;
  questions_json: string;
  answers_json: string;
  messages_json: string;
  artifacts_json: string | null;
  pending_revision_json: string | null;
  confirmations_json: string;
  doc_id: string | null;
  spec_id: string | null;
  proposal_id: string | null;
  analysis_json: string | null;
  analysis_run_id: string | null;
  refinement_id: string | null;
  task_ids_json: string;
  active_queue_id: string | null;
  active_run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface PlannerSessionSummaryRow {
  id: string;
  workspace_id: string;
  repo: string;
  title: string;
  step: FeaturePlanningSession['step'];
  status: FeaturePlanningSession['status'];
  active_action: FeaturePlanningSession['activeAction'];
  clarification_state_json: string | null;
  questions_json: string;
  answers_json: string;
  updated_at: number;
}

interface PlannerEventRow {
  id: number;
  session_id: string;
  kind: string;
  detail_json: string;
  created_at: number;
}

interface PlannerUsageTotalsRow {
  session_id: string;
  total_runs: number;
  total_input_tokens: number;
  total_output_tokens: number;
  repository_scan_runs: number;
  cached_snapshot_runs: number;
}

/**
 * The parameters both statements that write a session bind. Identity and
 * provenance are INSERT-only and `progress` is derived from the rest on read, so
 * neither belongs to the shared set, and a parameter the statement does not
 * declare is an error, not something the driver drops.
 */
function toParams(session: FeaturePlanningSession): Record<string, unknown> {
  const {
    progress: _progress,
    workspaceId: _workspaceId,
    repo: _repo,
    branch: _branch,
    author: _author,
    createdAt: _createdAt,
    ...stored
  } = session;
  return {
    ...stored,
    repositoryContext: session.repositoryContext ? JSON.stringify(session.repositoryContext) : null,
    clarification: JSON.stringify(session.clarification),
    brief: JSON.stringify(session.brief),
    questions: JSON.stringify(session.questions),
    answers: JSON.stringify(session.answers),
    messages: JSON.stringify(session.messages),
    artifacts: session.artifacts ? JSON.stringify(session.artifacts) : null,
    pendingRevision: session.pendingRevision ? JSON.stringify(session.pendingRevision) : null,
    confirmations: JSON.stringify(session.confirmations),
    analysis: session.analysis ? JSON.stringify(session.analysis) : null,
    taskIds: JSON.stringify(session.taskIds),
  };
}

function rowToSession(row: PlannerSessionRow): FeaturePlanningSession {
  const brief = safeParse<FeatureBrief>(row.brief_json, {
    problem: row.idea,
    audience: [],
    goal: '',
    mvp: [],
    outOfScope: [],
    assumptions: [],
    risks: [],
    openDecisions: [],
  });
  const storedRevision = row.pending_revision_json
    ? safeParse<StoredPlannerRevision | null>(row.pending_revision_json, null)
    : null;
  const questions = normalizeQuestions(safeParse<PlannerQuestion[]>(row.questions_json, []));
  const answers = normalizeAnswers(safeParse<PlannerAnswer[]>(row.answers_json, []), questions);
  const clarification = normalizeClarificationState(row.clarification_state_json, questions, answers);
  const sessionWithoutProgress: Omit<FeaturePlanningSession, 'progress'> = {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    branch: row.branch,
    targetBranch: row.target_branch || row.branch,
    author: row.author,
    title: row.title,
    idea: row.idea,
    step: row.step,
    status: row.status,
    revision: row.revision,
    activeAction: row.active_action,
    lastError: row.last_error,
    repositoryContext: row.repository_context_json
      ? safeParse<RepositoryPlanningContext | null>(row.repository_context_json, null)
      : null,
    brief,
    clarification,
    questions,
    answers,
    messages: safeParse(row.messages_json, []),
    artifacts: row.artifacts_json ? safeParse(row.artifacts_json, null) : null,
    pendingRevision: normalizePlannerRevision(storedRevision, brief),
    confirmations: safeParse(row.confirmations_json, { brief: false, artifacts: false, analysis: false, launch: false }),
    docId: row.doc_id,
    specId: row.spec_id,
    proposalId: row.proposal_id,
    analysis: row.analysis_json ? safeParse<ProposalAnalysis | null>(row.analysis_json, null) : null,
    analysisRunId: row.analysis_run_id,
    refinementId: row.refinement_id,
    taskIds: safeParse(row.task_ids_json, []),
    activeQueueId: row.active_queue_id,
    activeRunId: row.active_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { ...sessionWithoutProgress, progress: plannerProgress(sessionWithoutProgress) };
}

function rowToSummary(row: PlannerSessionSummaryRow): FeaturePlanningSessionSummary {
  const questions = normalizeQuestions(safeParse<PlannerQuestion[]>(row.questions_json, []));
  const answers = normalizeAnswers(safeParse<PlannerAnswer[]>(row.answers_json, []), questions);
  const input = {
    step: row.step,
    status: row.status,
    activeAction: row.active_action,
    clarification: normalizeClarificationState(row.clarification_state_json, questions, answers),
  };
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    title: row.title,
    status: row.status,
    progress: plannerProgress(input),
    updatedAt: row.updated_at,
  };
}

type StoredPlannerRevision = Partial<PlannerRevision> & {
  readonly summary: string;
  readonly kind?: PlannerRevision['kind'];
};

function normalizePlannerRevision(
  stored: StoredPlannerRevision | null,
  fallbackBrief: FeatureBrief,
): PlannerRevision | null {
  if (!stored) return null;
  const kind = stored.kind ?? 'plan';
  return {
    kind,
    summary: stored.summary,
    brief: stored.brief ?? (kind === 'tasks' ? null : fallbackBrief),
    artifacts: stored.artifacts ?? null,
    tasks: stored.tasks ?? null,
  };
}

function normalizeQuestions(questions: PlannerQuestion[]): PlannerQuestion[] {
  return questions.map((question) => ({
    ...question,
    decisionKey: question.decisionKey || legacyDecisionKey(question.prompt, question.id),
  }));
}

function normalizeAnswers(answers: PlannerAnswer[], activeQuestions: ReadonlyArray<PlannerQuestion>): PlannerAnswer[] {
  return answers.map((answer) => ({
    ...answer,
    decisionKey: answer.decisionKey
      || activeQuestions.find((question) => question.id === answer.questionId)?.decisionKey
      || legacyDecisionKey(answer.question, answer.questionId),
  }));
}

function normalizeClarificationState(
  raw: string | null,
  questions: ReadonlyArray<PlannerQuestion>,
  answers: ReadonlyArray<PlannerAnswer>,
): ClarificationState {
  const fallback = emptyClarificationState();
  const stored = raw ? safeParse<Partial<ClarificationState>>(raw, {}) : {};
  const resolvedDecisionKeys = Array.from(new Set([
    ...(stored.resolvedDecisionKeys ?? []),
    ...answers.map((answer) => answer.decisionKey),
  ]));
  const inferredCompletedRounds = answers.length > 0 ? Math.ceil(answers.length / 3) : 0;
  const roundsCreated = Math.max(stored.roundsCreated ?? 0, inferredCompletedRounds, questions.length > 0 ? inferredCompletedRounds + 1 : 0);
  return {
    currentRound: stored.currentRound ?? (questions.length > 0 ? Math.max(1, roundsCreated) : roundsCreated),
    roundsCreated,
    completedRounds: Math.max(stored.completedRounds ?? 0, inferredCompletedRounds),
    answerCount: Math.max(stored.answerCount ?? 0, answers.length),
    questionSetId: questions.length > 0 ? stored.questionSetId ?? `legacy-${questions[0]?.id ?? 'questions'}` : null,
    resolvedDecisionKeys,
    roundLimit: stored.roundLimit ?? fallback.roundLimit,
    answerLimit: stored.answerLimit ?? fallback.answerLimit,
    completionReason: stored.completionReason ?? null,
    completionExplanation: stored.completionExplanation ?? null,
    unresolvedDecisions: stored.unresolvedDecisions ?? [],
  };
}

function legacyDecisionKey(prompt: string, id: string): string {
  const normalized = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  return normalized || `legacy_${id.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`;
}

function isUsageRun(value: PlannerUsageRun | Readonly<Record<string, unknown>> | null): value is PlannerUsageRun {
  if (value === null) return false;
  const numeric = (field: keyof PlannerUsageRun): boolean =>
    typeof value[field] === 'number' && Number.isFinite(value[field]) && (value[field] as number) >= 0;
  return typeof value.runId === 'string'
    && typeof value.action === 'string'
    && (value.round === null || (typeof value.round === 'number' && Number.isInteger(value.round)))
    && (value.contextMode === 'repository_scan' || value.contextMode === 'cached_snapshot')
    && numeric('promptChars')
    && numeric('inputTokens')
    && numeric('outputTokens')
    && numeric('durationMs');
}
