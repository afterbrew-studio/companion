import type {
  ClarificationState,
  FeaturePlanningSession,
  PlannerProgress,
  PlannerProgressStage,
} from '../contract/index.js';

export const CLARIFICATION_ROUND_LIMIT = 5;
export const CLARIFICATION_ANSWER_LIMIT = 15;

export function emptyClarificationState(): ClarificationState {
  return {
    currentRound: 0,
    roundsCreated: 0,
    completedRounds: 0,
    answerCount: 0,
    questionSetId: null,
    resolvedDecisionKeys: [],
    roundLimit: CLARIFICATION_ROUND_LIMIT,
    answerLimit: CLARIFICATION_ANSWER_LIMIT,
    completionReason: null,
    completionExplanation: null,
    unresolvedDecisions: [],
  };
}

type ProgressInput = Pick<FeaturePlanningSession, 'step' | 'status' | 'activeAction' | 'clarification'>;

export function plannerProgress(session: ProgressInput): PlannerProgress {
  const questionStages = Array.from({ length: session.clarification.roundsCreated }, (_, index) => ({
    id: `questions-${index + 1}`,
    label: `Question round ${index + 1}`,
    technicalStep: 'clarification' as const,
    round: index + 1,
  }));
  const definitions = [
    { id: 'idea', label: 'Idea', technicalStep: 'idea' as const, round: null },
    ...questionStages,
    { id: 'mvp', label: 'MVP', technicalStep: 'scope_review' as const, round: null },
    { id: 'artifacts', label: 'Artifacts', technicalStep: 'artifacts_review' as const, round: null },
    { id: 'plan-review', label: 'Plan review', technicalStep: 'analysis_review' as const, round: null },
    { id: 'task-review', label: 'Task review', technicalStep: 'tasks_review' as const, round: null },
    { id: 'launched', label: 'Launched', technicalStep: 'launched' as const, round: null },
  ];
  const currentId = currentStageId(session, questionStages.length);
  const currentIndex = Math.max(0, definitions.findIndex((stage) => stage.id === currentId));
  const detail = progressDetail(session);
  const stages: PlannerProgressStage[] = definitions.map((stage, index) => ({
    id: stage.id,
    label: stage.label,
    state: index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'upcoming',
    detail: index === currentIndex ? detail : null,
  }));
  return { stages, currentIndex, completed: currentIndex, total: stages.length };
}

function currentStageId(session: ProgressInput, questionRounds: number): string {
  if (session.step === 'idea') return 'idea';
  if (session.step === 'clarification') {
    const activeRound = Math.min(
      questionRounds,
      Math.max(1, session.clarification.currentRound || questionRounds),
    );
    return questionRounds > 0 ? `questions-${activeRound}` : 'idea';
  }
  if (session.step === 'scope_review') return 'mvp';
  if (session.step === 'artifacts_review') return 'artifacts';
  if (session.step === 'analysis' || session.step === 'analysis_review') return 'plan-review';
  if (session.step === 'refinement' || session.step === 'tasks_review') return 'task-review';
  return 'launched';
}

function progressDetail(session: ProgressInput): string | null {
  if (session.status === 'failed') return 'Needs attention';
  if (session.status === 'waiting_for_user') return 'Waiting for your decision';
  if (session.activeAction === 'clarifying') return session.clarification.roundsCreated === 0
    ? 'Analyzing the idea and repository'
    : 'Preparing the next decision';
  if (session.activeAction === 'generating_artifacts' || session.activeAction === 'creating_artifacts') return 'Preparing planning artifacts';
  if (session.activeAction === 'analyzing') return 'Analyzing the implementation plan';
  if (session.activeAction === 'decomposing') return 'Preparing tasks';
  if (session.activeAction === 'launching') return 'Starting work';
  return null;
}
