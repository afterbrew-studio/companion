import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AuthUser, ServiceMap, SpaServerMessage } from '@companion/contracts';
import { log } from '@companion/services';
import type { RefineItemUpdate } from '@companion/module-refinement/contract';
import type {
  ArtifactBundle,
  FeatureBrief,
  FeaturePlanningSession,
  PlannerAnswer,
  PlannerSessionDetail,
} from '../contract/index.js';
import { isReadOnlyPlannerSession } from './planner-machine.js';
import { PlannerRevisionConflict, PlannerStore, type PlannerSessionPatch } from './planner-store.js';
import {
  artifactsPrompt,
  clarificationPrompt,
  emptyFeatureBrief,
  parseArtifactBundle,
  parseClarification,
  parsePlannerRevision,
  revisionPrompt,
} from './prompts.js';

type PlanService = ServiceMap['plan'];
type RefinementService = ServiceMap['refinement'];
type BoardService = ServiceMap['board'];
type CodeService = ServiceMap['code'];
type OperateService = ServiceMap['operate'];

const MAX_IDEA_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_MESSAGES = 100;
const MAX_ACTIVE_RUNS_PER_USER = 2;
const RUN_TIMEOUT_MS = 12 * 60_000;

export class PlannerService {
  constructor(
    private readonly store: PlannerStore,
    private readonly plan: PlanService,
    private readonly refinement: RefinementService,
    private readonly board: BoardService,
    private readonly code: CodeService,
    private readonly operate: OperateService,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  create(input: { workspaceId: string; repo: string; idea: string; title?: string }, author: string): FeaturePlanningSession {
    this.ensureRunCapacity(author);
    const idea = input.idea.trim();
    if (!idea || idea.length > MAX_IDEA_LENGTH) throw new Error(`idea must be between 1 and ${MAX_IDEA_LENGTH} characters`);
    const repo = this.code.repos.get(input.repo);
    if (!repo || !this.code.repos.inWorkspace(input.repo, input.workspaceId)) {
      throw new Error(`repo ${input.repo} is not connected to this workspace`);
    }
    const now = Date.now();
    const session: FeaturePlanningSession = {
      id: `idea-${randomUUID().slice(0, 12)}`,
      workspaceId: input.workspaceId,
      repo: input.repo,
      branch: repo.default_branch,
      author,
      title: input.title?.trim().slice(0, 200) || deriveTitle(idea),
      idea,
      step: 'idea',
      status: 'draft',
      revision: 0,
      activeAction: null,
      lastError: null,
      brief: emptyFeatureBrief(idea),
      questions: [],
      answers: [],
      messages: [{ id: messageId(), role: 'user', content: idea, createdAt: now }],
      artifacts: null,
      pendingRevision: null,
      confirmations: { brief: false, artifacts: false, analysis: false, launch: false },
      docId: null,
      specId: null,
      proposalId: null,
      analysis: null,
      analysisRunId: null,
      refinementId: null,
      taskIds: [],
      activeQueueId: null,
      activeRunId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(session);
    this.changed(session.id);
    return session;
  }

  list(workspaceId: string): FeaturePlanningSession[] {
    return this.store.listByWorkspace(workspaceId);
  }

  get(id: string): FeaturePlanningSession | undefined {
    return this.store.get(id);
  }

  detail(id: string, user: AuthUser): PlannerSessionDetail | undefined {
    const session = this.store.get(id);
    if (!session) return undefined;
    const refinementItems = session.refinementId ? this.refinement.get(session.refinementId)?.items ?? [] : [];
    const snapshot = this.board.listBoard(user, session.workspaceId);
    return {
      session,
      events: this.store.listEvents(id),
      refinementItems,
      board: { config: snapshot.config, workers: snapshot.workers },
    };
  }

  legacyActiveCount(workspaceId: string): number {
    const plannerProposalIds = new Set(
      this.store.listByWorkspace(workspaceId).flatMap((session) => session.proposalId ? [session.proposalId] : []),
    );
    return this.plan.proposals
      .list(workspaceId)
      .filter((proposal) => !plannerProposalIds.has(proposal.id) && !['implemented', 'rejected'].includes(proposal.status))
      .length;
  }

  startClarification(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'clarifying') return current;
    if (!['idea', 'clarification'].includes(current.step) && !(current.step === 'clarification' && current.status === 'failed')) {
      throw new Error(`clarification is not available from ${current.step}`);
    }
    const started = this.begin(id, expectedRevision, 'clarification', 'clarifying', userId, 'clarification_started');
    void this.runClarification(started.id, userId);
    return started;
  }

  answer(
    id: string,
    expectedRevision: number,
    input: { answers: ReadonlyArray<{ questionId: string; optionId?: string | null; value?: string }> },
    userId: string,
  ): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'clarifying') return current;
    if (current.step !== 'clarification' || current.status !== 'waiting_for_user') {
      throw new Error('this session is not waiting for clarification answers');
    }
    const now = Date.now();
    const round: PlannerAnswer[] = current.questions.map((question) => {
      const submitted = input.answers.find((answer) => answer.questionId === question.id);
      if (!submitted) throw new Error(`answer required for: ${question.prompt}`);
      const option = submitted.optionId ? question.options.find((entry) => entry.id === submitted.optionId) : undefined;
      const value = (option?.label ?? submitted.value ?? '').trim();
      if (!value || value.length > MAX_MESSAGE_LENGTH) throw new Error('each answer must be between 1 and 4000 characters');
      return { questionId: question.id, question: question.prompt, optionId: option?.id ?? null, value, createdAt: now };
    });
    const answerText = current.questions
      .map((question) => `${question.prompt}\n${round.find((answer) => answer.questionId === question.id)!.value}`)
      .join('\n\n');
    const messages = appendMessages(current.messages, [{ id: messageId(), role: 'user', content: answerText, createdAt: now }]);
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      answers: [...current.answers, ...round],
      messages,
      questions: [],
      status: 'working',
      activeAction: 'clarifying',
      lastError: null,
      activeQueueId: null,
      activeRunId: null,
    }, { expectedRevision, event: 'clarification_answered', detail: { count: round.length } });
    this.changed(id);
    void this.runClarification(id, userId);
    return started;
  }

  confirmBrief(id: string, expectedRevision: number, brief: FeatureBrief, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'generating_artifacts') return current;
    if (current.step !== 'scope_review' || current.status !== 'waiting_for_user') {
      throw new Error('the feature brief is not ready for confirmation');
    }
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      brief,
      step: 'artifacts_review',
      status: 'working',
      activeAction: 'generating_artifacts',
      lastError: null,
      confirmations: { ...current.confirmations, brief: true },
      activeQueueId: null,
      activeRunId: null,
    }, { expectedRevision, event: 'brief_confirmed' });
    this.changed(id);
    void this.runArtifactGeneration(id, userId);
    return started;
  }

  saveArtifacts(id: string, expectedRevision: number, artifacts: ArtifactBundle): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.step !== 'artifacts_review' || current.status === 'working') {
      throw new Error('artifact drafts cannot be edited now');
    }
    return this.updateAndBroadcast(id, {
      artifacts,
      pendingRevision: null,
      confirmations: { ...current.confirmations, artifacts: false },
    }, expectedRevision, 'artifact_drafts_edited');
  }

  createArtifacts(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'creating_artifacts' || current.activeAction === 'analyzing') return current;
    if (current.step !== 'artifacts_review' || !current.artifacts) throw new Error('artifact drafts are not ready');
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      status: 'working',
      activeAction: 'creating_artifacts',
      lastError: null,
      confirmations: { ...current.confirmations, artifacts: true },
    }, { expectedRevision, event: 'artifact_creation_started' });
    this.changed(id);
    void this.persistArtifactsAndAnalyze(id, userId);
    return started;
  }

  retry(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.status !== 'failed') throw new Error('only a failed step can be retried');
    if (current.step === 'clarification') return this.startClarification(id, expectedRevision, userId);
    if (current.step === 'artifacts_review') {
      if (current.artifacts) return this.createArtifacts(id, expectedRevision, userId);
      this.ensureRunCapacity(userId);
      const started = this.store.update(id, {
        status: 'working', activeAction: 'generating_artifacts', lastError: null,
        activeQueueId: null, activeRunId: null,
      }, { expectedRevision, event: 'artifact_generation_retried' });
      this.changed(id);
      void this.runArtifactGeneration(id, userId);
      return started;
    }
    if (current.step === 'analysis') {
      if (!current.pendingRevision) return this.retryAnalysis(id, expectedRevision, userId);
      this.ensureRunCapacity(userId);
      const started = this.store.update(id, {
        status: 'working', activeAction: 'analyzing', lastError: null,
        activeQueueId: null, activeRunId: null,
      }, { expectedRevision, event: 'revision_apply_retried' });
      this.changed(id);
      void this.applyRevisionAndAnalyze(id, userId);
      return started;
    }
    if (current.step === 'refinement') {
      this.ensureRunCapacity(userId);
      const started = this.store.update(id, {
        status: 'working', activeAction: 'decomposing', lastError: null,
        activeQueueId: null, activeRunId: null,
      }, { expectedRevision, event: 'refinement_retried' });
      this.changed(id);
      void this.createRefinement(id, userId);
      return started;
    }
    throw new Error(`step ${current.step} has no retry action`);
  }

  retryAnalysis(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (!current.proposalId || !current.docId || !current.specId) throw new Error('planning artifacts are incomplete');
    if (!['analysis', 'analysis_review'].includes(current.step)) throw new Error('analysis cannot run from this step');
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      step: 'analysis', status: 'working', activeAction: 'analyzing', lastError: null,
      activeQueueId: null, activeRunId: null,
    }, { expectedRevision, event: 'analysis_retried' });
    this.changed(id);
    void this.analyze(id, userId);
    return started;
  }

  requestRevision(id: string, expectedRevision: number, instruction: string, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'revising') return current;
    if (current.step !== 'analysis_review' || !current.artifacts) throw new Error('analysis is not ready for revision');
    const value = instruction.trim();
    if (!value || value.length > MAX_MESSAGE_LENGTH) throw new Error('revision request must be between 1 and 4000 characters');
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      status: 'working', activeAction: 'revising', lastError: null,
      messages: appendMessages(current.messages, [{ id: messageId(), role: 'user', content: value, createdAt: Date.now() }]),
      activeQueueId: null, activeRunId: null,
    }, { expectedRevision, event: 'revision_requested' });
    this.changed(id);
    void this.runRevision(id, value, userId);
    return started;
  }

  applyRevision(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'analyzing') return current;
    if (current.step !== 'analysis_review' || !current.pendingRevision) throw new Error('there is no pending revision');
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      step: 'analysis', status: 'working', activeAction: 'analyzing', lastError: null,
      analysis: null, analysisRunId: null,
    }, { expectedRevision, event: 'revision_apply_started' });
    this.changed(id);
    void this.applyRevisionAndAnalyze(id, userId);
    return started;
  }

  prepareTasks(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'decomposing') return current;
    if (current.step !== 'analysis_review' || !current.analysis || !current.proposalId) {
      throw new Error('the implementation plan is not ready');
    }
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      step: 'refinement', status: 'working', activeAction: 'decomposing', lastError: null,
      confirmations: { ...current.confirmations, analysis: true },
      activeQueueId: null, activeRunId: null,
    }, { expectedRevision, event: 'refinement_started' });
    this.changed(id);
    void this.createRefinement(id, userId);
    return started;
  }

  updateRefinementItem(id: string, expectedRevision: number, itemId: string, fields: RefineItemUpdate): FeaturePlanningSession {
    const current = this.requireTaskReview(id, expectedRevision);
    this.refinement.updateItem(current.refinementId!, itemId, fields);
    return this.touch(id, expectedRevision, 'refinement_item_edited', { itemId });
  }

  moveRefinementItem(id: string, expectedRevision: number, itemId: string, direction: 'up' | 'down'): FeaturePlanningSession {
    const current = this.requireTaskReview(id, expectedRevision);
    this.refinement.moveItem(current.refinementId!, itemId, direction);
    return this.touch(id, expectedRevision, 'refinement_item_moved', { itemId, direction });
  }

  mergeRefinementItems(
    id: string,
    expectedRevision: number,
    itemIds: readonly string[],
    fields: { title?: string; description?: string; acceptance?: string; priority?: 0 | 1 | 2 | 3 },
  ): FeaturePlanningSession {
    const current = this.requireTaskReview(id, expectedRevision);
    this.refinement.mergeItems(current.refinementId!, itemIds, fields);
    return this.touch(id, expectedRevision, 'refinement_items_merged', { itemIds });
  }

  dismissRefinementItem(id: string, expectedRevision: number, itemId: string): FeaturePlanningSession {
    const current = this.requireTaskReview(id, expectedRevision);
    this.refinement.dismissItem(current.refinementId!, itemId);
    return this.touch(id, expectedRevision, 'refinement_item_dismissed', { itemId });
  }

  launch(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.mustGet(id);
    if (current.step === 'launched') return current;
    if (isReadOnlyPlannerSession(current.step, current.status)) throw new Error('this planning session is read-only');
    if (current.activeAction === 'launching') return current;
    if (current.step !== 'tasks_review' || !current.refinementId) throw new Error('tasks are not ready to launch');
    const refinement = this.refinement.get(current.refinementId)?.refinement;
    if (!refinement || refinement.workspaceId !== current.workspaceId || refinement.repo !== current.repo) {
      throw new Error('the linked refinement no longer matches this idea');
    }
    const started = this.store.update(id, {
      status: 'working', activeAction: 'launching', lastError: null,
    }, { expectedRevision, event: 'launch_started' });
    this.changed(id);
    try {
      this.refinement.importAll(current.refinementId, userId, true, current.branch);
      const items = this.refinement.get(current.refinementId)?.items ?? [];
      const taskIds = items.flatMap((item) => item.taskId ? [item.taskId] : []);
      return this.updateAndBroadcast(id, {
        step: 'launched', status: 'completed', activeAction: null, lastError: null,
        taskIds, confirmations: { ...current.confirmations, launch: true },
      }, undefined, 'launched', { taskIds });
    } catch (err) {
      const items = this.refinement.get(current.refinementId)?.items ?? [];
      const taskIds = items.flatMap((item) => item.taskId ? [item.taskId] : []);
      this.fail(id, err, { taskIds });
      throw err;
    }
  }

  async stop(id: string, expectedRevision: number): Promise<FeaturePlanningSession> {
    const current = this.requireMutable(id);
    if (current.revision !== expectedRevision) throw new PlannerRevisionConflict(current);
    const stopped = this.updateAndBroadcast(id, {
      status: 'failed', activeAction: null, activeQueueId: null, activeRunId: null,
      lastError: 'Stopped by user. This step can be retried.',
    }, expectedRevision, 'stopped');
    if (current.activeQueueId) this.operate.orchestrator.cancelQueued(current.activeQueueId);
    if (current.activeRunId) await this.operate.orchestrator.stopRun(current.activeRunId).catch(() => undefined);
    return this.store.get(id) ?? stopped;
  }

  async cancel(id: string, expectedRevision: number): Promise<FeaturePlanningSession> {
    const current = this.requireMutable(id);
    if (current.revision !== expectedRevision) throw new PlannerRevisionConflict(current);
    const cancelled = this.updateAndBroadcast(id, {
      status: 'cancelled', activeAction: null, activeQueueId: null, activeRunId: null, lastError: null,
    }, expectedRevision, 'cancelled');
    if (current.activeQueueId) this.operate.orchestrator.cancelQueued(current.activeQueueId);
    if (current.activeRunId) await this.operate.orchestrator.stopRun(current.activeRunId).catch(() => undefined);
    return this.store.get(id) ?? cancelled;
  }

  resetDangling(): number {
    const count = this.store.resetDangling();
    if (count > 0) this.changed();
    return count;
  }

  private async runClarification(id: string, userId: string): Promise<void> {
    try {
      const session = this.mustGet(id);
      await this.ensureClone(session, userId);
      const answers = session.answers.map((answer) => ({
        question: answer.question,
        answer: answer.value,
      }));
      const result = await this.runStructured(id, userId, 'Clarify idea', clarificationPrompt({ idea: session.idea, brief: session.brief, answers }));
      const parsed = parseClarification(result);
      const nextStep = parsed.questions.length > 0 ? 'clarification' : 'scope_review';
      this.updateAndBroadcast(id, {
        step: nextStep,
        status: 'waiting_for_user',
        activeAction: null,
        activeQueueId: null,
        activeRunId: null,
        lastError: null,
        brief: parsed.brief,
        questions: parsed.questions,
        messages: appendMessages(this.mustGet(id).messages, [{
          id: messageId(), role: 'assistant', content: parsed.summary, createdAt: Date.now(),
        }]),
      }, undefined, parsed.questions.length > 0 ? 'questions_ready' : 'brief_ready', { questions: parsed.questions.length });
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async runArtifactGeneration(id: string, userId: string): Promise<void> {
    try {
      const session = this.mustGet(id);
      await this.ensureClone(session, userId);
      const output = await this.runStructured(id, userId, 'Draft planning artifacts', artifactsPrompt(session.idea, session.brief));
      const artifacts = parseArtifactBundle(output);
      this.updateAndBroadcast(id, {
        artifacts,
        status: 'waiting_for_user',
        activeAction: null,
        activeQueueId: null,
        activeRunId: null,
        lastError: null,
      }, undefined, 'artifact_drafts_ready');
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async persistArtifactsAndAnalyze(id: string, userId: string): Promise<void> {
    try {
      let session = this.mustGet(id);
      const artifacts = session.artifacts!;
      if (!session.docId) {
        const doc = this.plan.docs.create(session.workspaceId, {
          repo: session.repo, title: artifacts.documentation.title, content: artifacts.documentation.content, storage: 'virtual',
        }, 'generated');
        session = this.updateAndBroadcast(id, { docId: doc.id }, undefined, 'artifact_created', { kind: 'documentation', id: doc.id });
      }
      if (!session.specId) {
        const spec = this.plan.specs.create(session.workspaceId, session.repo, artifacts.specification.title, artifacts.specification.content, 'virtual');
        session = this.updateAndBroadcast(id, { specId: spec.id }, undefined, 'artifact_created', { kind: 'specification', id: spec.id });
      }
      if (!session.proposalId) {
        const proposal = this.plan.proposals.create(session.workspaceId, session.repo, artifacts.implementationPlan.title, artifacts.implementationPlan.content);
        session = this.updateAndBroadcast(id, { proposalId: proposal.id }, undefined, 'artifact_created', { kind: 'implementation_plan', id: proposal.id });
      }
      this.updateAndBroadcast(id, {
        step: 'analysis', activeAction: 'analyzing', status: 'working', lastError: null,
      }, undefined, 'analysis_started');
      await this.analyze(id, userId);
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async analyze(id: string, userId: string): Promise<void> {
    try {
      const session = this.mustGet(id);
      const doc = session.docId ? this.plan.docs.get(session.docId) : undefined;
      const spec = session.specId ? this.plan.specs.get(session.specId) : undefined;
      const proposal = await this.plan.proposals.analyze(session.proposalId!, userId, {
        documentation: doc ? [{ title: doc.title, content: doc.content }] : [],
        specifications: spec ? [{ title: spec.title, content: spec.content }] : [],
        onQueued: (queueId) => this.trackQueued(id, queueId),
        onStarted: (runId) => this.trackStarted(id, runId),
      });
      if (!proposal.analysis) throw new Error('analysis completed without a validated result');
      this.updateAndBroadcast(id, {
        step: 'analysis_review', status: 'waiting_for_user', activeAction: null,
        activeQueueId: null, activeRunId: null, lastError: null,
        analysis: proposal.analysis, analysisRunId: proposal.analysisRunId,
      }, undefined, 'analysis_ready');
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async runRevision(id: string, instruction: string, userId: string): Promise<void> {
    try {
      const session = this.mustGet(id);
      await this.ensureClone(session, userId);
      const output = await this.runStructured(id, userId, 'Revise implementation plan', revisionPrompt(instruction, session.brief, session.artifacts!));
      const pendingRevision = parsePlannerRevision(output);
      this.updateAndBroadcast(id, {
        pendingRevision, status: 'waiting_for_user', activeAction: null,
        activeQueueId: null, activeRunId: null, lastError: null,
        messages: appendMessages(this.mustGet(id).messages, [{
          id: messageId(), role: 'assistant', content: pendingRevision.summary, createdAt: Date.now(),
        }]),
      }, undefined, 'revision_ready');
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async applyRevisionAndAnalyze(id: string, userId: string): Promise<void> {
    try {
      let session = this.mustGet(id);
      const revision = session.pendingRevision!;
      this.plan.docs.update(session.docId!, {
        title: revision.artifacts.documentation.title, content: revision.artifacts.documentation.content,
      });
      this.plan.specs.update(session.specId!, {
        title: revision.artifacts.specification.title, content: revision.artifacts.specification.content,
      });
      this.plan.proposals.update(session.proposalId!, {
        title: revision.artifacts.implementationPlan.title, body: revision.artifacts.implementationPlan.content,
      });
      session = this.updateAndBroadcast(id, {
        artifacts: revision.artifacts, pendingRevision: null, analysis: null, analysisRunId: null,
      }, undefined, 'revision_applied');
      await this.analyze(session.id, userId);
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async createRefinement(id: string, userId: string): Promise<void> {
    try {
      let session = this.mustGet(id);
      this.plan.proposals.acceptPlan(session.proposalId!);
      let refinementId = session.refinementId;
      if (!refinementId) {
        const created = this.refinement.create({
          workspaceId: session.workspaceId,
          repo: session.repo,
          branch: session.branch,
          title: session.title,
          story: session.artifacts?.implementationPlan.content ?? session.idea,
        });
        refinementId = created.id;
        session = this.updateAndBroadcast(id, { refinementId }, undefined, 'refinement_created', { id: refinementId });
      }
      const detail = this.refinement.get(refinementId);
      if (detail?.refinement.status === 'ready' && detail.items.some((item) => item.status === 'proposed')) {
        this.updateAndBroadcast(id, {
          step: 'tasks_review', status: 'waiting_for_user', activeAction: null,
          activeQueueId: null, activeRunId: null, lastError: null,
        }, undefined, 'tasks_ready');
        return;
      }
      const method = this.refinement.startDecompose(refinementId, {
        methodId: 'builtin-vertical-slices',
        specIds: session.specId ? [session.specId] : [],
        docIds: session.docId ? [session.docId] : [],
      });
      await this.refinement.runDecompose(refinementId, method, userId, {
        onQueued: (queueId) => this.trackQueued(id, queueId),
        onStarted: (runId) => this.trackStarted(id, runId),
      });
      const completed = this.refinement.get(refinementId);
      if (completed?.refinement.status !== 'ready') {
        throw new Error(completed?.refinement.error ?? 'task decomposition failed');
      }
      this.updateAndBroadcast(id, {
        step: 'tasks_review', status: 'waiting_for_user', activeAction: null,
        activeQueueId: null, activeRunId: null, lastError: null,
      }, undefined, 'tasks_ready', { count: completed.items.filter((item) => item.status === 'proposed').length });
    } catch (err) {
      this.fail(id, err);
    }
  }

  private async runStructured(id: string, userId: string, title: string, prompt: string): Promise<string> {
    const session = this.mustGet(id);
    const result = await this.operate.orchestrator.runOneShot({
      kind: 'analysis', task: 'planner.analyses', title: `${title}: ${session.title}`.slice(0, 100),
      cwd: this.operate.checkouts.cloneDir(session.repo), repo: session.repo, userId, prompt, timeoutMs: RUN_TIMEOUT_MS,
      onQueued: (queueId) => this.trackQueued(id, queueId),
      onStarted: (runId) => this.trackStarted(id, runId),
    });
    if (result.finalMessage === null) throw new Error('the planning agent ended without a response');
    return result.finalMessage;
  }

  private async ensureClone(session: FeaturePlanningSession, userId: string): Promise<void> {
    await this.operate.checkouts.clone(session.repo, undefined, userId);
  }

  private begin(
    id: string,
    expectedRevision: number,
    step: FeaturePlanningSession['step'],
    action: NonNullable<FeaturePlanningSession['activeAction']>,
    userId: string,
    event: string,
  ): FeaturePlanningSession {
    this.ensureRunCapacity(userId);
    return this.updateAndBroadcast(id, {
      step, status: 'working', activeAction: action, lastError: null,
      activeQueueId: null, activeRunId: null,
    }, expectedRevision, event);
  }

  private ensureRunCapacity(userId: string): void {
    if (this.store.countActiveRuns(userId) >= MAX_ACTIVE_RUNS_PER_USER) {
      throw new Error(`you already have ${MAX_ACTIVE_RUNS_PER_USER} active planning runs`);
    }
  }

  private trackQueued(id: string, queueId: string): void {
    const session = this.store.get(id);
    if (!session || !session.activeAction || session.status !== 'working') return;
    this.updateAndBroadcast(id, { activeQueueId: queueId }, undefined, 'run_queued', { queueId });
  }

  private trackStarted(id: string, runId: string): void {
    const session = this.store.get(id);
    if (!session || !session.activeAction || session.status !== 'working') return;
    this.updateAndBroadcast(id, { activeQueueId: null, activeRunId: runId }, undefined, 'run_started', { runId });
  }

  private fail(id: string, err: unknown, patch: PlannerSessionPatch = {}): void {
    const session = this.store.get(id);
    if (!session || session.status !== 'working' || !session.activeAction || session.step === 'launched') return;
    const technicalMessage = String(err instanceof Error ? err.message : err).slice(0, 4_000);
    const message = err instanceof ZodError
      ? 'The planning response did not match the expected structure. Retry this step.'
      : technicalMessage.slice(0, 1_000);
    log.warn('planner action failed', { id, action: session.activeAction, err: technicalMessage });
    try {
      this.updateAndBroadcast(id, {
        ...patch, status: 'failed', activeAction: null, activeQueueId: null, activeRunId: null, lastError: message,
      }, undefined, 'failed', { error: message });
    } catch (updateError) {
      log.warn('planner failure state could not be stored', { id, err: String(updateError) });
    }
  }

  private requireMutable(id: string): FeaturePlanningSession {
    const session = this.mustGet(id);
    if (isReadOnlyPlannerSession(session.step, session.status)) throw new Error('this planning session is read-only');
    return session;
  }

  private requireTaskReview(id: string, expectedRevision: number): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.revision !== expectedRevision) throw new PlannerRevisionConflict(current);
    if (current.step !== 'tasks_review' || current.status !== 'waiting_for_user' || !current.refinementId) {
      throw new Error('tasks are not ready for editing');
    }
    return current;
  }

  private mustGet(id: string): FeaturePlanningSession {
    const session = this.store.get(id);
    if (!session) throw new Error('planning session not found');
    return session;
  }

  private touch(id: string, expectedRevision: number, event: string, detail: Readonly<Record<string, unknown>>): FeaturePlanningSession {
    return this.updateAndBroadcast(id, {}, expectedRevision, event, detail);
  }

  private updateAndBroadcast(
    id: string,
    patch: PlannerSessionPatch,
    expectedRevision?: number,
    event?: string,
    detail?: Readonly<Record<string, unknown>>,
  ): FeaturePlanningSession {
    const session = this.store.update(id, patch, { expectedRevision, event, detail });
    this.changed(id);
    return session;
  }

  private changed(_sessionId?: string): void {
    this.broadcast({ t: 'planner.changed' });
  }
}

function deriveTitle(idea: string): string {
  const first = (idea.split(/\n|[.!?](?:\s|$)/, 1)[0]?.trim() || 'New idea').replace(/\s+/g, ' ');
  if (first.length <= 96) return first;
  const clipped = first.slice(0, 95);
  const wordBoundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, wordBoundary > 64 ? wordBoundary : clipped.length).trimEnd()}…`;
}

function messageId(): string {
  return `pm-${randomUUID().slice(0, 12)}`;
}

function appendMessages(
  current: FeaturePlanningSession['messages'],
  incoming: FeaturePlanningSession['messages'],
): FeaturePlanningSession['messages'] {
  const combined = [...current, ...incoming];
  return combined.slice(Math.max(0, combined.length - MAX_MESSAGES));
}
