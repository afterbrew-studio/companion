import type { RunRoutingDecision, RunRoutingProvider, RunRoutingRequest, RunRoutingResolution } from '@companion/module-operate/contract';
import type { ServiceMap } from '@moxxy/companion-contracts';
import type {
  ModelRouterPolicy,
  ModelRouterPolicyUpdate,
  ModelRouterSnapshot,
} from '../contract/index.js';
import { ModelRouterStore } from './model-router-store.js';

type OperateService = ServiceMap['operate'];

/** Policy provider and client-safe audit projection. It never launches work. */
export class ModelRouterService implements RunRoutingProvider {
  constructor(
    private readonly store: ModelRouterStore,
    private readonly operate: OperateService,
    private readonly changed: () => void,
  ) {}

  policy(): ModelRouterPolicy {
    return this.store.policy();
  }

  updatePolicy(update: ModelRouterPolicyUpdate): ModelRouterPolicy {
    const policy = this.store.updatePolicy(update);
    this.changed();
    return policy;
  }

  resolve(request: RunRoutingRequest): RunRoutingResolution | null {
    if (!request.task || !request.phase) return null;
    const policy = this.store.policy();
    if (!policy.enabled) return null;
    const rule = policy.rules.find(
      (candidate) => candidate.enabled && candidate.task === request.task && candidate.phase === request.phase,
    );
    if (!rule) return null;
    const profile = policy.profiles.find((candidate) => candidate.id === rule.profileId);
    if (!profile || profile.models.length === 0) return null;
    const candidateModels = [...new Set(profile.models.map((model) => model.trim()).filter(Boolean))];
    if (candidateModels.length === 0) return null;
    return {
      policyRevision: policy.revision,
      ruleId: rule.id,
      profileId: profile.id,
      candidateModels,
      unavailable: profile.unavailable,
    };
  }

  record(decision: RunRoutingDecision): void {
    this.store.record(decision);
    this.changed();
  }

  snapshot(): ModelRouterSnapshot {
    const decisions = this.store.decisions(200);
    const usage = this.operate.usageForRuns(decisions.map((decision) => decision.runId));
    const hydrated = decisions.map((decision) => {
      const runUsage = usage.get(decision.runId);
      return runUsage
        ? {
            ...decision,
            inputTokens: runUsage.inputTokens,
            outputTokens: runUsage.outputTokens,
            estimatedCostUsd: runUsage.estimatedCostUsd,
            telemetry: runUsage.telemetry,
          }
        : decision;
    });
    const historyTruncated = decisions.length === 200;
    const workUnits = new Map<string, ModelRouterSnapshot['workUnits'][number]>();
    for (const decision of hydrated) {
      if (!decision.workUnitId) continue;
      const current = workUnits.get(decision.workUnitId) ?? {
        id: decision.workUnitId,
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        partial: historyTruncated,
        lastAt: decision.createdAt,
      };
      workUnits.set(decision.workUnitId, {
        ...current,
        runs: current.runs + 1,
        inputTokens: current.inputTokens + (decision.inputTokens ?? 0),
        outputTokens: current.outputTokens + (decision.outputTokens ?? 0),
        estimatedCostUsd: current.estimatedCostUsd + (decision.estimatedCostUsd ?? 0),
        partial: current.partial || decision.telemetry !== 'reported' || decision.estimatedCostUsd === null,
        lastAt: Math.max(current.lastAt, decision.createdAt),
      });
    }
    return {
      policy: this.store.policy(),
      models: this.operate.runners.servableModels().map((model) => ({
        id: model.id,
        machines: model.machines.length,
      })),
      decisions: hydrated.slice(0, 50),
      workUnits: [...workUnits.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 20),
    };
  }
}
