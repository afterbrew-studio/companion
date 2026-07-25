import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AuthUser, ServiceMap, SpaServerMessage } from '@companion/contracts';
import type { NotificationEmitter, NotificationInput } from '@companion/core/server';
import { log } from '@companion/services';
import type { RefineItemUpdate } from '@companion/module-refinement/contract';
import type {
  ArtifactBundle,
  FeatureBrief,
  FeaturePlanningSession,
  PlannerAnswer,
  PlannerDiscussionContext,
  PlannerMessage,
  PlannerSessionDetail,
} from '../contract/index.js';
import { isReadOnlyPlannerSession } from './planner-machine.js';
import { PlannerRevisionConflict, PlannerStore, type PlannerSessionPatch } from './planner-store.js';
import {
  artifactsPrompt,
  clarificationPrompt,
  discussionPrompt,
  emptyFeatureBrief,
  parseArtifactBundle,
  parseClarification,
  parseInitialClarification,
  parsePlannerDiscussion,
  parsePlannerRevision,
  revisionPrompt,
} from './prompts.js';

type PlanService = ServiceMap['plan'];
type RefinementService = ServiceMap['refinement'];
type BoardService = ServiceMap['board'];
type CodeService = ServiceMap['code'];
type OperateService = ServiceMap['operate'];
type PlannerAction = NonNullable<FeaturePlanningSession['activeAction']>;

interface PlannerActionLease {
  readonly token: string;
  readonly action: PlannerAction;
}

const MAX_IDEA_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_MESSAGES = 100;
const MAX_ACTIVE_RUNS_PER_USER = 2;
const MAX_CLARIFICATION_ROUNDS = 5;
const MAX_CLARIFICATION_ANSWERS = 15;
const MAX_QUESTIONS_PER_ROUND = 3;
const RUN_TIMEOUT_MS = 12 * 60_000;

export class PlannerService {
  private readonly actionLeases = new Map<string, PlannerActionLease>();

  constructor(
    private readonly store: PlannerStore,
    private readonly plan: PlanService,
    private readonly refinement: RefinementService,
    private readonly board: BoardService,
    private readonly code: CodeService,
    private readonly operate: OperateService,
    private readonly notify: NotificationEmitter,
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
      targetBranch: repo.default_branch,
      author,
      title: input.title?.trim().slice(0, 200) || deriveTitle(idea),
      idea,
      step: 'idea',
      status: 'draft',
      revision: 0,
      activeAction: null,
      lastError: null,
      repositoryContext: null,
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
    return this.store
      .listByWorkspace(workspaceId)
      .filter((session) => session.status !== 'cancelled');
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
    if (current.step === 'analysis_review') {
      const lastUserMessage = [...current.messages].reverse().find((message) => message.role === 'user');
      const instruction = lastUserMessage?.content.trim();
      if (!instruction) throw new Error('the revision request is no longer available');
      this.ensureRunCapacity(userId);
      const retryingDiscussion = lastUserMessage?.context !== undefined;
      const started = this.store.update(id, {
        status: 'working', activeAction: retryingDiscussion ? 'discussing' : 'revising', lastError: null,
        activeQueueId: null, activeRunId: null,
      }, { expectedRevision, event: retryingDiscussion ? 'discussion_retried' : 'revision_retried' });
      this.changed(id);
      if (retryingDiscussion) void this.runDiscussion(id, instruction, lastUserMessage.context, userId);
      else void this.runRevision(id, instruction, userId);
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

  discuss(
    id: string,
    expectedRevision: number,
    message: string,
    context: PlannerDiscussionContext | undefined,
    userId: string,
  ): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'discussing' || current.activeAction === 'revising') return current;
    if (current.step !== 'analysis_review' || current.status !== 'waiting_for_user' || !current.analysis || !current.artifacts) {
      throw new Error('plan discussion is available after the implementation analysis is ready');
    }
    const value = message.trim();
    if (!value || value.length > MAX_MESSAGE_LENGTH) throw new Error('message must be between 1 and 4000 characters');
    this.ensureRunCapacity(userId);
    const normalizedContext = context ?? 'plan_summary';
    const userMessage: PlannerMessage = {
      id: messageId(), role: 'user', content: value, createdAt: Date.now(), context: normalizedContext,
    };
    const started = this.store.update(id, {
      status: 'working', activeAction: 'discussing', lastError: null,
      messages: appendMessages(current.messages, [userMessage]),
      activeQueueId: null, activeRunId: null,
    }, { expectedRevision, event: 'discussion_started', detail: { context: normalizedContext } });
    this.changed(id);
    void this.runDiscussion(id, value, normalizedContext, userId);
    return started;
  }

  requestRevision(id: string, expectedRevision: number, instruction: string, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'discussing' || current.activeAction === 'revising') return current;
    if (current.step !== 'analysis_review' || current.status !== 'waiting_for_user' || !current.artifacts) {
      throw new Error('analysis is not ready for revision');
    }
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
    if (current.step !== 'analysis_review' || current.status !== 'waiting_for_user' || !current.pendingRevision) {
      throw new Error('there is no pending revision');
    }
    this.ensureRunCapacity(userId);
    const started = this.store.update(id, {
      step: 'analysis', status: 'working', activeAction: 'analyzing', lastError: null,
      analysis: null, analysisRunId: null,
    }, { expectedRevision, event: 'revision_apply_started' });
    this.changed(id);
    void this.applyRevisionAndAnalyze(id, userId);
    return started;
  }

  discardRevision(id: string, expectedRevision: number): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.step !== 'analysis_review' || current.status !== 'waiting_for_user' || !current.pendingRevision) {
      throw new Error('there is no pending revision');
    }
    return this.updateAndBroadcast(id, {
      pendingRevision: null,
      status: 'waiting_for_user',
      lastError: null,
    }, expectedRevision, 'revision_discarded');
  }

  prepareTasks(id: string, expectedRevision: number, userId: string): FeaturePlanningSession {
    const current = this.requireMutable(id);
    if (current.activeAction === 'decomposing') return current;
    if (current.step !== 'analysis_review' || current.status !== 'waiting_for_user' || !current.analysis || !current.proposalId) {
      throw new Error('the implementation plan is not ready');
    }
    if (current.pendingRevision) throw new Error('apply or discard the pending revision before preparing tasks');
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

  launch(id: string, expectedRevision: number, userId: string, targetBranch?: string): FeaturePlanningSession {
    const current = this.mustGet(id);
    if (current.step === 'launched') return current;
    if (isReadOnlyPlannerSession(current.step, current.status)) throw new Error('this planning session is read-only');
    if (current.activeAction === 'launching') return current;
    if (current.step !== 'tasks_review' || !current.refinementId) throw new Error('tasks are not ready to launch');
    const refinement = this.refinement.get(current.refinementId)?.refinement;
    if (!refinement || refinement.workspaceId !== current.workspaceId || refinement.repo !== current.repo) {
      throw new Error('the linked refinement no longer matches this idea');
    }
    const selectedTargetBranch = targetBranch?.trim() || current.targetBranch;
    if (!selectedTargetBranch || selectedTargetBranch.length > 300) throw new Error('target branch is invalid');
    this.store.update(id, {
      status: 'working', activeAction: 'launching', lastError: null, targetBranch: selectedTargetBranch,
    }, { expectedRevision, event: 'launch_started', detail: { targetBranch: selectedTargetBranch } });
    this.changed(id);
    try {
      this.refinement.importAll(current.refinementId, userId, true, selectedTargetBranch);
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
    this.actionLeases.delete(id);
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
    this.actionLeases.delete(id);
    if (current.activeQueueId) this.operate.orchestrator.cancelQueued(current.activeQueueId);
    if (current.activeRunId) await this.operate.orchestrator.stopRun(current.activeRunId).catch(() => undefined);
    return this.store.get(id) ?? cancelled;
  }

  resetDangling(): number {
    const count = this.store.resetDangling();
    this.actionLeases.clear();
    if (count > 0) this.changed();
    return count;
  }

  private async runClarification(id: string, userId: string): Promise<void> {
    const lease = this.claimAction(id, 'clarifying');
    try {
      const session = this.mustGet(id);
      const needsRepositoryScan = session.repositoryContext === null;
      if (needsRepositoryScan) await this.ensureClone(session, userId);
      if (!this.ownsAction(id, lease)) return;
      const answers = this.latestClarificationAnswers(id, session).map((answer) => ({
        question: answer.question,
        answer: answer.value,
      }));
      const maxQuestions = this.remainingClarificationQuestions(id, session.answers.length);
      const prompt = clarificationPrompt({
        idea: session.idea,
        brief: session.brief,
        answers,
        maxQuestions,
        repositoryContext: session.repositoryContext,
      });
      const result = await this.runStructured(id, userId, 'Clarify idea', prompt, lease, {
        repositoryAccess: needsRepositoryScan,
      });
      if (!this.ownsAction(id, lease)) return;
      const initialResult = needsRepositoryScan ? parseInitialClarification(result) : null;
      const parsed = initialResult ?? parseClarification(result);
      const repositoryContext = initialResult?.repositoryContext ?? session.repositoryContext;
      // The model still updates the brief after the last answers, but cannot
      // extend clarification beyond the durable session budget.
      const questions = parsed.questions.slice(0, maxQuestions);
      const nextStep = questions.length > 0 ? 'clarification' : 'scope_review';
      this.updateAndBroadcast(id, {
        step: nextStep,
        status: 'waiting_for_user',
        activeAction: null,
        activeQueueId: null,
        activeRunId: null,
        lastError: null,
        repositoryContext,
        brief: parsed.brief,
        questions,
        messages: appendMessages(this.mustGet(id).messages, [{
          id: messageId(), role: 'assistant', content: parsed.summary, createdAt: Date.now(),
        }]),
      }, undefined, questions.length > 0 ? 'questions_ready' : 'brief_ready', {
        questions: questions.length,
        contextMode: needsRepositoryScan ? 'repository_scan' : 'cached_snapshot',
      });
    } catch (err) {
      if (this.ownsAction(id, lease)) this.fail(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async runArtifactGeneration(id: string, userId: string): Promise<void> {
    const lease = this.claimAction(id, 'generating_artifacts');
    try {
      const session = this.mustGet(id);
      const needsRepositoryScan = session.repositoryContext === null;
      if (needsRepositoryScan) await this.ensureClone(session, userId);
      if (!this.ownsAction(id, lease)) return;
      const output = await this.runStructured(
        id,
        userId,
        'Draft planning artifacts',
        artifactsPrompt(session.idea, session.brief, session.repositoryContext),
        lease,
        { repositoryAccess: needsRepositoryScan },
      );
      if (!this.ownsAction(id, lease)) return;
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
      if (this.ownsAction(id, lease)) this.fail(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async persistArtifactsAndAnalyze(id: string, userId: string): Promise<void> {
    const lease = this.claimAction(id, 'creating_artifacts');
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
      if (this.ownsAction(id, lease)) this.fail(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async analyze(id: string, userId: string): Promise<void> {
    const lease = this.claimAction(id, 'analyzing');
    try {
      const session = this.mustGet(id);
      const doc = session.docId ? this.plan.docs.get(session.docId) : undefined;
      const spec = session.specId ? this.plan.specs.get(session.specId) : undefined;
      const proposal = await this.plan.proposals.analyze(session.proposalId!, userId, {
        documentation: doc ? [{ title: doc.title, content: doc.content }] : [],
        specifications: spec ? [{ title: spec.title, content: spec.content }] : [],
        onQueued: (queueId) => this.trackQueued(id, queueId, lease),
        onStarted: (runId) => this.trackStarted(id, runId, lease),
      });
      if (!this.ownsAction(id, lease)) return;
      if (!proposal.analysis) throw new Error('analysis completed without a validated result');
      // The brief is the product boundary approved by the user. Proposal
      // analysis may expand those groups into implementation findings, but the
      // Ideas review must keep the visible MVP count and wording canonical.
      const analysis = { ...proposal.analysis, mvp: session.brief.mvp };
      this.updateAndBroadcast(id, {
        step: 'analysis_review', status: 'waiting_for_user', activeAction: null,
        activeQueueId: null, activeRunId: null, lastError: null,
        analysis, analysisRunId: proposal.analysisRunId,
      }, undefined, 'analysis_ready');
    } catch (err) {
      if (this.ownsAction(id, lease)) this.fail(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async runDiscussion(
    id: string,
    message: string,
    context: PlannerDiscussionContext | undefined,
    userId: string,
  ): Promise<void> {
    const lease = this.claimAction(id, 'discussing');
    try {
      const session = this.mustGet(id);
      const needsRepositoryScan = session.repositoryContext === null;
      if (needsRepositoryScan) await this.ensureClone(session, userId);
      if (!this.ownsAction(id, lease)) return;
      const output = await this.runStructured(id, userId, 'Discuss implementation plan', discussionPrompt({
        session,
        message,
        ...(context ? { context } : {}),
      }), lease, { repositoryAccess: needsRepositoryScan });
      if (!this.ownsAction(id, lease)) return;
      const result = parsePlannerDiscussion(output, session);
      const assistantMessage: PlannerMessage = {
        id: messageId(),
        role: 'assistant',
        content: result.clarification?.question ?? result.answer,
        createdAt: Date.now(),
        intent: result.intent,
        context,
        references: result.references,
        ...(result.clarification ? { options: result.clarification.options } : {}),
      };
      this.updateAndBroadcast(id, {
        messages: appendMessages(this.mustGet(id).messages, [assistantMessage]),
        status: result.intent === 'change_request' ? 'working' : 'waiting_for_user',
        activeAction: result.intent === 'change_request' ? 'revising' : null,
        activeQueueId: null,
        activeRunId: null,
        lastError: null,
      }, undefined, result.intent === 'change_request' ? 'discussion_change_requested' : 'discussion_answered', { intent: result.intent });
      if (result.intent === 'change_request') {
        await this.runRevision(id, result.changeInstruction, userId, true);
      }
    } catch (err) {
      if (this.ownsAction(id, lease)) this.failConversation(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async runRevision(id: string, instruction: string, userId: string, fromDiscussion = false): Promise<void> {
    const lease = this.claimAction(id, 'revising');
    try {
      const session = this.mustGet(id);
      const needsRepositoryScan = session.repositoryContext === null;
      if (needsRepositoryScan) await this.ensureClone(session, userId);
      if (!this.ownsAction(id, lease)) return;
      const revisionBase = session.pendingRevision?.artifacts ?? session.artifacts!;
      const briefBase = session.pendingRevision?.brief ?? session.brief;
      const output = await this.runStructured(
        id,
        userId,
        'Revise implementation plan',
        revisionPrompt(instruction, briefBase, revisionBase, session.repositoryContext),
        lease,
        { repositoryAccess: needsRepositoryScan },
      );
      if (!this.ownsAction(id, lease)) return;
      const pendingRevision = parsePlannerRevision(output);
      this.updateAndBroadcast(id, {
        pendingRevision, status: 'waiting_for_user', activeAction: null,
        activeQueueId: null, activeRunId: null, lastError: null,
        messages: appendMessages(this.mustGet(id).messages, [{
          id: messageId(), role: 'assistant', content: pendingRevision.summary, createdAt: Date.now(), intent: 'change_request',
        }]),
      }, undefined, 'revision_ready');
    } catch (err) {
      if (this.ownsAction(id, lease)) {
        if (fromDiscussion) this.failConversation(id, err);
        else this.fail(id, err);
      }
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async applyRevisionAndAnalyze(id: string, userId: string): Promise<void> {
    const lease = this.claimAction(id, 'analyzing');
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
        brief: revision.brief, artifacts: revision.artifacts, pendingRevision: null, analysis: null, analysisRunId: null,
      }, undefined, 'revision_applied');
      await this.analyze(session.id, userId);
    } catch (err) {
      if (this.ownsAction(id, lease)) this.fail(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async createRefinement(id: string, userId: string): Promise<void> {
    const lease = this.claimAction(id, 'decomposing');
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
        onQueued: (queueId) => this.trackQueued(id, queueId, lease),
        onStarted: (runId) => this.trackStarted(id, runId, lease),
      });
      if (!this.ownsAction(id, lease)) return;
      const completed = this.refinement.get(refinementId);
      if (completed?.refinement.status !== 'ready') {
        throw new Error(completed?.refinement.error ?? 'task decomposition failed');
      }
      this.updateAndBroadcast(id, {
        step: 'tasks_review', status: 'waiting_for_user', activeAction: null,
        activeQueueId: null, activeRunId: null, lastError: null,
      }, undefined, 'tasks_ready', { count: completed.items.filter((item) => item.status === 'proposed').length });
    } catch (err) {
      if (this.ownsAction(id, lease)) this.fail(id, err);
    } finally {
      this.releaseAction(id, lease);
    }
  }

  private async runStructured(
    id: string,
    userId: string,
    title: string,
    prompt: string,
    lease: PlannerActionLease,
    options: { readonly repositoryAccess?: boolean } = {},
  ): Promise<string> {
    const session = this.mustGet(id);
    const repositoryAccess = options.repositoryAccess ?? true;
    log.info('planner structured run', {
      id,
      title,
      contextMode: repositoryAccess ? 'repository_scan' : 'cached_snapshot',
      promptChars: prompt.length,
    });
    const result = await this.operate.orchestrator.runOneShot({
      kind: 'analysis', task: 'planner.analyses', title: `${title}: ${session.title}`.slice(0, 100),
      ...(repositoryAccess ? { cwd: this.operate.checkouts.cloneDir(session.repo) } : {}),
      repo: session.repo, userId, prompt, timeoutMs: RUN_TIMEOUT_MS,
      onQueued: (queueId) => this.trackQueued(id, queueId, lease),
      onStarted: (runId) => this.trackStarted(id, runId, lease),
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

  private remainingClarificationQuestions(id: string, answerCount: number): number {
    const answeredRounds = this.store.listEvents(id)
      .filter((event) => event.kind === 'clarification_answered')
      .length;
    if (answeredRounds >= MAX_CLARIFICATION_ROUNDS) return 0;
    return Math.min(MAX_QUESTIONS_PER_ROUND, Math.max(0, MAX_CLARIFICATION_ANSWERS - answerCount));
  }

  private latestClarificationAnswers(
    id: string,
    session: FeaturePlanningSession,
  ): ReadonlyArray<PlannerAnswer> {
    const events = this.store.listEvents(id);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.kind !== 'clarification_answered') continue;
      const count = event.detail.count;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return [];
      return session.answers.slice(-Math.min(count, MAX_QUESTIONS_PER_ROUND));
    }
    return [];
  }

  private trackQueued(id: string, queueId: string, lease: PlannerActionLease): void {
    if (!this.ownsAction(id, lease)) return;
    this.updateAndBroadcast(id, { activeQueueId: queueId }, undefined, 'run_queued', { queueId });
  }

  private trackStarted(id: string, runId: string, lease: PlannerActionLease): void {
    if (!this.ownsAction(id, lease)) return;
    this.updateAndBroadcast(id, { activeQueueId: null, activeRunId: runId }, undefined, 'run_started', { runId });
  }

  private claimAction(id: string, action: PlannerAction): PlannerActionLease {
    const session = this.mustGet(id);
    if (session.status !== 'working' || session.activeAction !== action) {
      throw new Error(`planner action ${action} is no longer active`);
    }
    const lease = { token: randomUUID(), action };
    this.actionLeases.set(id, lease);
    return lease;
  }

  private ownsAction(id: string, lease: PlannerActionLease): boolean {
    const active = this.actionLeases.get(id);
    const session = this.store.get(id);
    return active?.token === lease.token
      && session?.status === 'working'
      && session.activeAction === lease.action;
  }

  private releaseAction(id: string, lease: PlannerActionLease): void {
    if (this.actionLeases.get(id)?.token === lease.token) this.actionLeases.delete(id);
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

  private failConversation(id: string, err: unknown): void {
    const session = this.store.get(id);
    if (!session || session.step !== 'analysis_review' || session.status !== 'working') return;
    const technicalMessage = String(err instanceof Error ? err.message : err).slice(0, 4_000);
    log.warn('planner discussion failed', { id, action: session.activeAction, err: technicalMessage });
    const message = err instanceof ZodError
      ? 'I could not interpret the planning response safely. Nothing was changed. Please try asking again.'
      : 'I could not finish that answer. Nothing was changed. Please try again.';
    try {
      this.updateAndBroadcast(id, {
        status: 'waiting_for_user', activeAction: null, activeQueueId: null, activeRunId: null, lastError: null,
        messages: appendMessages(session.messages, [{ id: messageId(), role: 'system', content: message, createdAt: Date.now() }]),
      }, undefined, 'discussion_failed', { error: message });
    } catch (updateError) {
      log.warn('planner discussion failure could not be stored', { id, err: String(updateError) });
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
    const previous = this.mustGet(id);
    const session = this.store.update(id, patch, { expectedRevision, event, detail });
    this.changed(id);
    this.notifyTransition(previous, session, event, detail);
    return session;
  }

  /**
   * Raise inbox entries only for meaningful workflow hand-offs. Intermediate
   * persistence updates still broadcast live state, but do not create noise in
   * the user's notification history.
   */
  private notifyTransition(
    previous: FeaturePlanningSession,
    session: FeaturePlanningSession,
    event?: string,
    detail?: Readonly<Record<string, unknown>>,
  ): void {
    const input = plannerNotification(previous, session, event, detail);
    if (!input) return;
    try {
      this.notify.emit(input);
    } catch (err) {
      // Inbox delivery is secondary to preserving a completed planner
      // checkpoint. A notification storage problem must not make an already
      // successful planning action appear to have failed.
      log.warn('planner notification could not be emitted', { id: session.id, event, err: String(err) });
    }
  }

  private changed(_sessionId?: string): void {
    this.broadcast({ t: 'planner.changed' });
  }
}

function plannerNotification(
  previous: FeaturePlanningSession,
  session: FeaturePlanningSession,
  event?: string,
  detail?: Readonly<Record<string, unknown>>,
): NotificationInput | null {
  const base = {
    workspaceId: session.workspaceId,
    repo: session.repo,
    href: `#/ideas/${session.id}`,
  } as const;

  if (event === 'failed' && previous.status !== 'failed' && session.status === 'failed') {
    return {
      ...base,
      kind: 'error',
      title: 'Idea planning needs attention',
      body: `${session.title}: ${session.lastError || 'A planning step failed. Open the idea to retry.'}`,
    };
  }

  if (event === 'discussion_failed' && previous.status === 'working' && session.status === 'waiting_for_user') {
    return {
      ...base,
      kind: 'error',
      title: 'The planner could not answer',
      body: `${session.title}: nothing was changed. Open the conversation and try again.`,
    };
  }

  if (event === 'launched' && previous.status === 'working' && session.status === 'completed') {
    const count = Array.isArray(detail?.taskIds) ? detail.taskIds.length : session.taskIds.length;
    return {
      ...base,
      kind: 'finished',
      title: 'Your idea is now on the Board',
      body: `${session.title}: ${count} ${count === 1 ? 'task was' : 'tasks were'} created and queued.`,
    };
  }

  if (previous.status !== 'working' || session.status !== 'waiting_for_user') return null;

  const actionRequired: Readonly<Record<string, { readonly title: string; readonly body: string }>> = {
    questions_ready: {
      title: 'Your idea needs answers',
      body: `${session.title}: ${session.questions.length} ${session.questions.length === 1 ? 'decision is' : 'decisions are'} ready for you.`,
    },
    brief_ready: {
      title: 'Review the first release',
      body: `${session.title}: the proposed outcome and MVP are ready for review.`,
    },
    artifact_drafts_ready: {
      title: 'Planning drafts are ready',
      body: `${session.title}: review the documentation, specification and implementation plan.`,
    },
    analysis_ready: {
      title: 'Review the implementation plan',
      body: `${session.title}: the codebase analysis is complete and ready for your decision.`,
    },
    discussion_answered: {
      title: 'The planner replied',
      body: `${session.title}: your planning conversation has a new answer.`,
    },
    revision_ready: {
      title: 'Review the proposed plan changes',
      body: `${session.title}: a revision is ready to apply or discard.`,
    },
    tasks_ready: {
      title: 'Tasks are ready for review',
      body: `${session.title}: review task content, order and dependencies before starting work.`,
    },
  };
  const notification = event ? actionRequired[event] : undefined;
  if (!notification) return null;
  return { ...base, kind: 'action_required', ...notification };
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
