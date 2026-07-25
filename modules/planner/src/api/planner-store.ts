import type Database from 'better-sqlite3';
import { safeParse } from '@companion/services';
import type {
  FeatureBrief,
  FeaturePlanningSession,
  PlannerEventRecord,
  PlannerRevision,
  RepositoryPlanningContext,
} from '../contract/index.js';
import type { ProposalAnalysis } from '@companion/module-plan/contract';
import { assertPlannerTransition } from './planner-machine.js';

export class PlannerRevisionConflict extends Error {
  constructor(readonly current: FeaturePlanningSession) {
    super(`planning session changed (current revision ${current.revision})`);
  }
}

export type PlannerSessionPatch = Partial<Omit<FeaturePlanningSession, 'id' | 'workspaceId' | 'repo' | 'branch' | 'author' | 'createdAt' | 'updatedAt' | 'revision'>>;

export class PlannerStore {
  constructor(private readonly db: Database.Database) {}

  insert(session: FeaturePlanningSession): void {
    this.db.prepare(`
      INSERT INTO planner_sessions (
        id, workspace_id, repo, branch, target_branch, author, title, idea, step, status, revision,
        active_action, last_error, repository_context_json, brief_json, questions_json, answers_json, messages_json,
        artifacts_json, pending_revision_json, confirmations_json, doc_id, spec_id, proposal_id,
        analysis_json, analysis_run_id, refinement_id, task_ids_json, active_queue_id, active_run_id,
        created_at, updated_at
      ) VALUES (
        @id, @workspaceId, @repo, @branch, @targetBranch, @author, @title, @idea, @step, @status, @revision,
        @activeAction, @lastError, @repositoryContext, @brief, @questions, @answers, @messages,
        @artifacts, @pendingRevision, @confirmations, @docId, @specId, @proposalId,
        @analysis, @analysisRunId, @refinementId, @taskIds, @activeQueueId, @activeRunId,
        @createdAt, @updatedAt
      )
    `).run(toParams(session));
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
      const next: FeaturePlanningSession = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      assertPlannerTransition(current.step, current.status, next.step, next.status);
      const result = this.db.prepare(`
        UPDATE planner_sessions SET
          title = @title, idea = @idea, step = @step, status = @status, revision = @revision,
          target_branch = @targetBranch,
          active_action = @activeAction, last_error = @lastError,
          repository_context_json = @repositoryContext, brief_json = @brief,
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
    this.db
      .prepare(`INSERT INTO planner_events (session_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, kind, JSON.stringify(detail), Date.now());
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

interface PlannerEventRow {
  id: number;
  session_id: string;
  kind: string;
  detail_json: string;
  created_at: number;
}

function toParams(session: FeaturePlanningSession): Record<string, unknown> {
  return {
    ...session,
    repositoryContext: session.repositoryContext ? JSON.stringify(session.repositoryContext) : null,
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
    ? safeParse<(Omit<PlannerRevision, 'brief'> & { readonly brief?: FeatureBrief }) | null>(row.pending_revision_json, null)
    : null;
  return {
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
    questions: safeParse(row.questions_json, []),
    answers: safeParse(row.answers_json, []),
    messages: safeParse(row.messages_json, []),
    artifacts: row.artifacts_json ? safeParse(row.artifacts_json, null) : null,
    // Revisions created before brief synchronization remain reviewable and
    // inherit the last approved brief until the user proposes another change.
    pendingRevision: storedRevision ? { ...storedRevision, brief: storedRevision.brief ?? brief } : null,
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
}
