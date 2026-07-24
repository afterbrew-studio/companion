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

export type PlannerAction = 'clarifying' | 'generating_artifacts' | 'creating_artifacts' | 'analyzing' | 'revising' | 'decomposing' | 'launching';

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

export interface PlannerQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
}

export interface PlannerQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly whyItMatters: string;
  readonly options: readonly [PlannerQuestionOption, PlannerQuestionOption, PlannerQuestionOption];
}

export interface PlannerAnswer {
  readonly questionId: string;
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
  readonly brief: FeatureBrief;
  readonly questions: ReadonlyArray<PlannerQuestion>;
}

export interface PlannerRevision {
  readonly summary: string;
  readonly artifacts: ArtifactBundle;
}

export interface PlannerConfirmations {
  readonly brief: boolean;
  readonly artifacts: boolean;
  readonly analysis: boolean;
  readonly launch: boolean;
}

export interface FeaturePlanningSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly branch: string;
  readonly author: string;
  readonly title: string;
  readonly idea: string;
  readonly step: PlannerStep;
  readonly status: PlannerStatus;
  readonly revision: number;
  readonly activeAction: PlannerAction | null;
  readonly lastError: string | null;
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
  readonly refinementItems: ReadonlyArray<RefineItemRecord>;
  readonly board: {
    readonly config: BoardConfig;
    readonly workers: ReadonlyArray<WorkerView>;
  };
}
