import type { ModelRouterPolicy, ModelRouterProfile, ModelRouterRule } from '../contract/index.js';

export const DEFAULT_PROFILES: readonly ModelRouterProfile[] = [
  {
    id: 'economy',
    label: 'Economy',
    description: 'Cheap routine work: clarification, summaries and bounded implementation.',
    models: [],
    unavailable: 'fallback',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Repairs and work that needs stronger reasoning without frontier-first cost.',
    models: [],
    unavailable: 'fallback',
  },
  {
    id: 'frontier',
    label: 'Frontier',
    description: 'Architecture, decomposition and high-impact planning.',
    models: [],
    unavailable: 'fallback',
  },
  {
    id: 'reviewer',
    label: 'Independent reviewer',
    description: 'A deliberately strong final critic; may fail closed when unavailable.',
    models: [],
    unavailable: 'fail',
  },
];

export const DEFAULT_RULES: readonly ModelRouterRule[] = [
  rule('planner-clarify', 'Idea clarification', 'planner.analyses', 'clarify', 'economy'),
  rule('planner-artifacts', 'Draft planning artifacts', 'planner.analyses', 'artifacts', 'balanced'),
  rule('planner-discuss', 'Planning discussion', 'planner.analyses', 'discuss', 'economy'),
  rule('planner-revise', 'Revise planning checkpoint', 'planner.analyses', 'revise', 'balanced'),
  rule('planner-compact', 'Compact feature brief', 'planner.analyses', 'compact', 'economy'),
  rule('plan-analyze', 'Analyze implementation plan', 'plan.analyses', 'analyze', 'frontier'),
  rule('plan-draft', 'Draft specification or documentation', 'plan.analyses', 'draft', 'balanced'),
  rule('plan-drift', 'Check specification drift', 'plan.analyses', 'drift', 'balanced'),
  rule('refinement-decompose', 'Decompose into implementation tasks', 'refinement.analyses', 'decompose', 'frontier'),
  rule('refinement-method', 'Draft refinement method', 'refinement.analyses', 'draft-method', 'balanced'),
  rule('board-implement', 'Implement board task', 'board.worker', 'implement', 'economy'),
  rule('board-repair', 'Repair board task', 'board.worker', 'repair', 'balanced'),
  rule('code-fix', 'AI Fix implementation', 'code.fix', 'implement', 'balanced'),
  rule('code-implement', 'Direct implementation', 'code.implement', 'implement', 'economy'),
  rule('code-pr-review', 'Pull request review', 'code.pr-review', 'review', 'reviewer'),
  rule('code-pr-summary', 'Review synthesis', 'code.pr-review', 'summarize', 'economy'),
  rule('code-review-verify', 'Verify serious finding', 'code.review-verify', 'verify', 'balanced'),
  rule('code-ci-analysis', 'Analyze CI failure', 'code.ci-analysis', 'analyze', 'economy'),
];

export function defaultPolicy(now = Date.now()): ModelRouterPolicy {
  return { revision: 1, enabled: false, profiles: DEFAULT_PROFILES, rules: DEFAULT_RULES, updatedAt: now };
}

function rule(
  id: string,
  label: string,
  task: string,
  phase: string,
  profileId: ModelRouterRule['profileId'],
): ModelRouterRule {
  return { id, label, task, phase, profileId, enabled: true };
}
