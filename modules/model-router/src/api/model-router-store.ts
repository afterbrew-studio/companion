import { randomUUID } from 'node:crypto';
import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  ModelRouterDecision,
  ModelRouterPolicy,
  ModelRouterPolicyUpdate,
  ModelRouterProfile,
  ModelRouterProfileId,
  ModelRouterRule,
} from '../contract/index.js';
import type { RunRoutingDecision } from '@companion/module-operate/contract';
import { defaultPolicy } from './default-policy.js';

interface PolicyRow {
  revision: number;
  enabled: number;
  profiles: string;
  rules: string;
  updated_at: number;
}

interface DecisionRow {
  id: string;
  run_id: string;
  task: string;
  phase: string;
  work_unit_id: string | null;
  risk: string | null;
  policy_revision: number;
  rule_id: string;
  profile_id: string;
  candidate_models: string;
  selected_model: string | null;
  outcome: string;
  created_at: number;
}

const PROFILE_IDS = new Set<ModelRouterProfileId>(['economy', 'balanced', 'frontier', 'reviewer']);

export class ModelRouterStore {
  constructor(private readonly db: Database) {}

  policy(): ModelRouterPolicy {
    let row = this.db.prepare(`SELECT * FROM model_router_policy WHERE id = 'default'`).get() as PolicyRow | undefined;
    if (!row) {
      const policy = defaultPolicy();
      this.db
        .prepare(
          `INSERT INTO model_router_policy (id, revision, enabled, profiles, rules, updated_at)
           VALUES ('default', ?, ?, ?, ?, ?)`,
        )
        .run(policy.revision, Number(policy.enabled), JSON.stringify(policy.profiles), JSON.stringify(policy.rules), policy.updatedAt);
      row = this.db.prepare(`SELECT * FROM model_router_policy WHERE id = 'default'`).get() as PolicyRow;
    }
    return rowToPolicy(row);
  }

  updatePolicy(update: ModelRouterPolicyUpdate): ModelRouterPolicy {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE model_router_policy
         SET revision = revision + 1, enabled = ?, profiles = ?, rules = ?, updated_at = ?
         WHERE id = 'default' AND revision = ?`,
      )
      .run(
        Number(update.enabled),
        JSON.stringify(update.profiles),
        JSON.stringify(update.rules),
        now,
        update.expectedRevision,
      );
    if (result.changes !== 1) throw new Error('Model Router policy changed in another session; reload and try again');
    return this.policy();
  }

  record(decision: RunRoutingDecision): void {
    this.db
      .prepare(
        `INSERT INTO model_router_decisions (
          id, run_id, task, phase, work_unit_id, risk, policy_revision, rule_id,
          profile_id, candidate_models, selected_model, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          selected_model = excluded.selected_model,
          outcome = excluded.outcome`,
      )
      .run(
        `route-${randomUUID().slice(0, 12)}`,
        decision.runId,
        decision.task ?? 'unattributed',
        decision.phase ?? 'default',
        decision.workUnitId ?? null,
        decision.risk ?? null,
        decision.policyRevision,
        decision.ruleId,
        decision.profileId,
        JSON.stringify(decision.candidateModels),
        decision.selectedModel,
        decision.outcome,
        Date.now(),
      );
    // Audit is operational evidence, not an infinite transcript. Run records
    // remain canonical; keep the newest 5,000 decisions in this projection.
    this.db.exec(`
      DELETE FROM model_router_decisions
      WHERE id IN (
        SELECT id FROM model_router_decisions
        ORDER BY created_at DESC
        LIMIT -1 OFFSET 5000
      )
    `);
  }

  decisions(limit = 50): ModelRouterDecision[] {
    const rows = this.db
      .prepare(`SELECT * FROM model_router_decisions ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(200, Math.max(1, limit))) as DecisionRow[];
    return rows.map(rowToDecision);
  }
}

function rowToPolicy(row: PolicyRow): ModelRouterPolicy {
  const fallback = defaultPolicy(row.updated_at);
  const parsedProfiles = safeParse<unknown>(row.profiles, null);
  const profiles = Array.isArray(parsedProfiles) && parsedProfiles.length === 4 && parsedProfiles.every(isProfile)
    ? parsedProfiles
    : [...fallback.profiles];
  const parsedRules = safeParse<unknown>(row.rules, null);
  const rules = Array.isArray(parsedRules) && parsedRules.every(isRule)
    ? parsedRules
    : [...fallback.rules];
  return {
    revision: row.revision,
    enabled: row.enabled === 1,
    profiles,
    rules,
    updatedAt: row.updated_at,
  };
}

function rowToDecision(row: DecisionRow): ModelRouterDecision {
  return {
    id: row.id,
    runId: row.run_id,
    task: row.task,
    phase: row.phase,
    workUnitId: row.work_unit_id,
    risk: row.risk === 'low' || row.risk === 'medium' || row.risk === 'high' ? row.risk : null,
    policyRevision: row.policy_revision,
    ruleId: row.rule_id,
    profileId: PROFILE_IDS.has(row.profile_id as ModelRouterProfileId)
      ? (row.profile_id as ModelRouterProfileId)
      : 'balanced',
    candidateModels: safeParse<unknown[]>(row.candidate_models, []).filter(
      (model): model is string => typeof model === 'string',
    ),
    selectedModel: row.selected_model,
    outcome: row.outcome === 'routed' || row.outcome === 'overridden' ? row.outcome : 'fallback',
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    telemetry: null,
    createdAt: row.created_at,
  };
}

function isProfile(value: unknown): value is ModelRouterProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<ModelRouterProfile>;
  return PROFILE_IDS.has(profile.id as ModelRouterProfileId)
    && typeof profile.label === 'string'
    && typeof profile.description === 'string'
    && Array.isArray(profile.models)
    && profile.models.every((model) => typeof model === 'string')
    && (profile.unavailable === 'fallback' || profile.unavailable === 'fail');
}

function isRule(value: unknown): value is ModelRouterRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<ModelRouterRule>;
  return typeof rule.id === 'string'
    && typeof rule.label === 'string'
    && typeof rule.task === 'string'
    && typeof rule.phase === 'string'
    && PROFILE_IDS.has(rule.profileId as ModelRouterProfileId)
    && typeof rule.enabled === 'boolean';
}
