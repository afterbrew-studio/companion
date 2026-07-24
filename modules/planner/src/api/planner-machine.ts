import type { PlannerStatus, PlannerStep } from '../contract/index.js';

const STEP_TRANSITIONS: Readonly<Record<PlannerStep, ReadonlySet<PlannerStep>>> = {
  idea: new Set(['clarification']),
  clarification: new Set(['clarification', 'scope_review']),
  scope_review: new Set(['artifacts_review']),
  artifacts_review: new Set(['analysis', 'artifacts_review']),
  analysis: new Set(['analysis_review', 'artifacts_review']),
  analysis_review: new Set(['analysis', 'refinement', 'analysis_review']),
  refinement: new Set(['tasks_review', 'refinement']),
  tasks_review: new Set(['tasks_review', 'launched']),
  launched: new Set(),
};

const STATUS_TRANSITIONS: Readonly<Record<PlannerStatus, ReadonlySet<PlannerStatus>>> = {
  draft: new Set(['working', 'cancelled']),
  working: new Set(['waiting_for_user', 'failed', 'completed', 'cancelled', 'working']),
  waiting_for_user: new Set(['working', 'cancelled', 'waiting_for_user']),
  failed: new Set(['working', 'cancelled', 'failed']),
  completed: new Set(['completed']),
  cancelled: new Set(['cancelled']),
};

export function assertPlannerTransition(
  fromStep: PlannerStep,
  fromStatus: PlannerStatus,
  toStep: PlannerStep,
  toStatus: PlannerStatus,
): void {
  if (fromStep !== toStep && !STEP_TRANSITIONS[fromStep].has(toStep)) {
    throw new Error(`cannot move planner step from ${fromStep} to ${toStep}`);
  }
  if (fromStatus !== toStatus && !STATUS_TRANSITIONS[fromStatus].has(toStatus)) {
    throw new Error(`cannot move planner status from ${fromStatus} to ${toStatus}`);
  }
  if (fromStep === 'launched' && (toStep !== 'launched' || toStatus !== 'completed')) {
    throw new Error('launched planning sessions are read-only');
  }
}

export function isReadOnlyPlannerSession(step: PlannerStep, status: PlannerStatus): boolean {
  return step === 'launched' || status === 'completed' || status === 'cancelled';
}
