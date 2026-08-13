import '@companion/module-core/contract';
import '@companion/module-operate/contract';
import type { ModelRouterService } from '../api/model-router-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'model-router:read': true;
    'model-router:manage': true;
  }
  interface ServerMessageRegistry {
    'model-router.changed': Record<never, never>;
  }
  interface ServiceMap {
    'model-router': ModelRouterService;
  }
}

export type ModelRouterProfileId = 'economy' | 'balanced' | 'frontier' | 'reviewer';

/** Ordered model fallback chain for one quality/cost tier. */
export interface ModelRouterProfile {
  readonly id: ModelRouterProfileId;
  readonly label: string;
  readonly description: string;
  readonly models: readonly string[];
  readonly unavailable: 'fallback' | 'fail';
}

/** Exact task+phase match. A disabled or unconfigured rule is a no-op. */
export interface ModelRouterRule {
  readonly id: string;
  readonly label: string;
  readonly task: string;
  readonly phase: string;
  readonly profileId: ModelRouterProfileId;
  readonly enabled: boolean;
}

export interface ModelRouterPolicy {
  readonly revision: number;
  readonly enabled: boolean;
  readonly profiles: readonly ModelRouterProfile[];
  readonly rules: readonly ModelRouterRule[];
  readonly updatedAt: number;
}

export interface ModelRouterPolicyUpdate {
  readonly expectedRevision: number;
  readonly enabled: boolean;
  readonly profiles: readonly ModelRouterProfile[];
  readonly rules: readonly ModelRouterRule[];
}

export interface ModelRouterModelOption {
  readonly id: string;
  readonly machines: number;
}

export interface ModelRouterDecision {
  readonly id: string;
  readonly runId: string;
  readonly task: string;
  readonly phase: string;
  readonly workUnitId: string | null;
  readonly risk: 'low' | 'medium' | 'high' | null;
  readonly policyRevision: number;
  readonly ruleId: string;
  readonly profileId: ModelRouterProfileId;
  readonly candidateModels: readonly string[];
  readonly selectedModel: string | null;
  readonly outcome: 'routed' | 'overridden' | 'fallback';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly telemetry: 'reported' | 'missing' | 'unsupported' | null;
  readonly createdAt: number;
}

export interface ModelRouterSnapshot {
  readonly policy: ModelRouterPolicy;
  readonly models: readonly ModelRouterModelOption[];
  readonly decisions: readonly ModelRouterDecision[];
  /** Bounded recent workflow roll-up; one idea/card/review may span many runs. */
  readonly workUnits: readonly ModelRouterWorkUnitSummary[];
}

export interface ModelRouterWorkUnitSummary {
  readonly id: string;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** At least one run had missing usage or pricing, so cost is a floor. */
  readonly partial: boolean;
  readonly lastAt: number;
}
