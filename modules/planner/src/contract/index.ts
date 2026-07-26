import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-code/contract';
import '@companion/module-operate/contract';
import '@companion/module-plan/contract';
import '@companion/module-board/contract';
import '@companion/module-refinement/contract';
import type { BoardConfig, WorkerView } from '@companion/module-board/contract';
import type { ProposalAnalysis } from '@companion/module-plan/contract';
import type { RefineItemRecord } from '@companion/module-refinement/contract';
import type { PlannerService } from '../api/planner-service.js';

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'planner:read': true;
    'planner:manage': true;
    'planner:execute': true;
  }
  interface ServerMessageRegistry {
    'planner.changed': Record<never, never>;
  }
  interface ServiceMap {
    planner: PlannerService;
  }
}

export type PlannerStep =
  | 'idea'
  | 'clarification'
  | 'scope_review'
  | 'artifacts_review'
  | 'analysis'
  | 'analysis_review'
  | 'refinement'
  | 'tasks_review'
  | 'launched';

export type PlannerStatus = 'draft' | 'working' | 'waiting_for_user' | 'failed' | 'completed' | 'cancelled';

export type PlannerAction = 'clarifying' | 'generating_artifacts' | 'creating_artifacts' | 'analyzing' | 'discussing' | 'revising' | 'decomposing' | 'launching';

export const PLANNER_DISCUSSION_CONTEXTS = [
  'plan_summary',
  'implementation_steps',
  'code_areas',
  'review_items',
  'architecture',
  'data_model_and_migrations',
  'api_and_ui',
  'authorization_privacy_security',
  'dependencies',
  'costs',
  'tests',
  'mvp',
  'later',
  'risks',
  'open_decisions',
] as const;

export type PlannerDiscussionContext = typeof PLANNER_DISCUSSION_CONTEXTS[number];
export type PlannerDiscussionIntent = 'explanation' | 'change_request' | 'clarification_needed';

export interface FeatureBrief {
  readonly problem: string;
  readonly audience: ReadonlyArray<string>;
  readonly goal: string;
  readonly mvp: ReadonlyArray<string>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly openDecisions: ReadonlyArray<string>;
}

/**
 * Compact, immutable repository knowledge captured during the first planning
 * run. Later product decisions use this instead of repeatedly scanning the
 * checkout; the final Proposal analysis still validates the completed plan
 * against the live repository.
 */
export interface RepositoryPlanningContext {
  readonly summary: string;
  readonly runtimeAndStack: ReadonlyArray<string>;
  readonly architecture: ReadonlyArray<string>;
  readonly dataAndIntegrations: ReadonlyArray<string>;
  readonly authorizationAndSecurity: ReadonlyArray<string>;
  readonly testingAndDelivery: ReadonlyArray<string>;
  readonly relevantPaths: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
}

export interface PlannerQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
}

export interface PlannerQuestion {
  readonly id: string;
  readonly decisionKey: string;
  readonly prompt: string;
  readonly whyItMatters: string;
  readonly options: readonly [PlannerQuestionOption, PlannerQuestionOption, PlannerQuestionOption];
}

export interface PlannerAnswer {
  readonly questionId: string;
  readonly decisionKey: string;
  readonly question: string;
  readonly optionId: string | null;
  readonly value: string;
  readonly createdAt: number;
}

export interface PlannerMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: number;
  readonly intent?: PlannerDiscussionIntent;
  readonly context?: PlannerDiscussionContext;
  readonly options?: readonly [PlannerQuestionOption, PlannerQuestionOption, PlannerQuestionOption];
  readonly references?: ReadonlyArray<PlannerDiscussionReference>;
}

export interface PlannerDiscussionReference {
  readonly context: PlannerDiscussionContext;
  readonly location: string;
  readonly label: string;
  readonly count: number | null;
}

export interface ArtifactDraft {
  readonly title: string;
  readonly content: string;
}

export interface ArtifactBundle {
  readonly documentation: ArtifactDraft;
  readonly specification: ArtifactDraft;
  readonly implementationPlan: ArtifactDraft;
}

export interface ClarificationResult {
  readonly summary: string;
  readonly readiness: 'ready' | 'needs_input';
  readonly readinessReason: string;
  readonly blockingDecisions: ReadonlyArray<string>;
  readonly brief: FeatureBrief;
  readonly questions: ReadonlyArray<PlannerQuestion>;
}

export interface InitialClarificationResult extends ClarificationResult {
  readonly repositoryContext: RepositoryPlanningContext;
}

export interface PlannerRevision {
  readonly summary: string;
  readonly brief: FeatureBrief;
  readonly artifacts: ArtifactBundle;
}

export type PlannerDiscussionResult =
  | {
      readonly intent: 'explanation';
      readonly answer: string;
      readonly references: ReadonlyArray<PlannerDiscussionReference>;
      readonly changeInstruction: null;
      readonly clarification: null;
    }
  | {
      readonly intent: 'change_request';
      readonly answer: string;
      readonly references: ReadonlyArray<PlannerDiscussionReference>;
      readonly changeInstruction: string;
      readonly clarification: null;
    }
  | {
      readonly intent: 'clarification_needed';
      readonly answer: string;
      readonly references: ReadonlyArray<PlannerDiscussionReference>;
      readonly changeInstruction: null;
      readonly clarification: {
        readonly question: string;
        readonly options: readonly [PlannerQuestionOption, PlannerQuestionOption, PlannerQuestionOption];
      };
    };

export interface PlannerConfirmations {
  readonly brief: boolean;
  readonly artifacts: boolean;
  readonly analysis: boolean;
  readonly launch: boolean;
}

export type ClarificationCompletionReason = 'ready' | 'limit_reached' | 'no_new_decisions';

export interface ClarificationState {
  readonly currentRound: number;
  readonly roundsCreated: number;
  readonly completedRounds: number;
  readonly answerCount: number;
  readonly questionSetId: string | null;
  readonly resolvedDecisionKeys: ReadonlyArray<string>;
  readonly roundLimit: number;
  readonly answerLimit: number;
  readonly completionReason: ClarificationCompletionReason | null;
  readonly completionExplanation: string | null;
  readonly unresolvedDecisions: ReadonlyArray<string>;
}

export interface PlannerProgressStage {
  readonly id: string;
  readonly label: string;
  readonly state: 'completed' | 'current' | 'upcoming';
  readonly detail: string | null;
}

export interface PlannerProgress {
  readonly stages: ReadonlyArray<PlannerProgressStage>;
  readonly currentIndex: number;
  readonly completed: number;
  readonly total: number;
}

export interface PlannerUsageRun {
  readonly runId: string;
  readonly action: string;
  readonly round: number | null;
  readonly contextMode: 'repository_scan' | 'cached_snapshot';
  readonly promptChars: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

export interface PlannerUsageSummary {
  readonly runs: ReadonlyArray<PlannerUsageRun>;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly repositoryScanRuns: number;
  readonly cachedSnapshotRuns: number;
}

export interface FeaturePlanningSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly branch: string;
  readonly targetBranch: string;
  readonly author: string;
  readonly title: string;
  readonly idea: string;
  readonly step: PlannerStep;
  readonly status: PlannerStatus;
  readonly revision: number;
  readonly activeAction: PlannerAction | null;
  readonly lastError: string | null;
  readonly repositoryContext: RepositoryPlanningContext | null;
  readonly clarification: ClarificationState;
  readonly progress: PlannerProgress;
  readonly brief: FeatureBrief;
  readonly questions: ReadonlyArray<PlannerQuestion>;
  readonly answers: ReadonlyArray<PlannerAnswer>;
  readonly messages: ReadonlyArray<PlannerMessage>;
  readonly artifacts: ArtifactBundle | null;
  readonly pendingRevision: PlannerRevision | null;
  readonly confirmations: PlannerConfirmations;
  readonly docId: string | null;
  readonly specId: string | null;
  readonly proposalId: string | null;
  readonly analysis: ProposalAnalysis | null;
  readonly analysisRunId: string | null;
  readonly refinementId: string | null;
  readonly taskIds: ReadonlyArray<string>;
  readonly activeQueueId: string | null;
  readonly activeRunId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PlannerEventRecord {
  readonly id: number;
  readonly sessionId: string;
  readonly kind: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface PlannerSessionDetail {
  readonly session: FeaturePlanningSession;
  readonly events: ReadonlyArray<PlannerEventRecord>;
  readonly usage: PlannerUsageSummary;
  readonly refinementItems: ReadonlyArray<RefineItemRecord>;
  readonly board: {
    readonly config: BoardConfig;
    readonly workers: ReadonlyArray<WorkerView>;
  };
}
