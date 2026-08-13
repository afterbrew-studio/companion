import { useEffect, useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  ListCard,
  Page,
  PageHeader,
  PageLoading,
  Section,
  SettingRow,
  Switch,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type {
  ModelRouterDecision,
  ModelRouterModelOption,
  ModelRouterPolicy,
  ModelRouterProfile,
  ModelRouterProfileId,
} from '../../contract/index.js';
import { useModelRouter } from '../hooks/useModelRouter.js';

/** Configure ordered model tiers, map workflow phases to them, and audit what
 * actually ran. Explicit per-run/card choices remain above this policy. */
export function ModelRouterPage(): React.JSX.Element {
  const { can } = useAuth();
  const { snapshot, error, saving, save } = useModelRouter();
  const [draft, setDraft] = useState<ModelRouterPolicy | null>(null);
  useEffect(() => {
    if (snapshot) setDraft(snapshot.policy);
  }, [snapshot?.policy.revision]);

  if (!snapshot || !draft) return <PageLoading label="Loading Model Router…" />;
  const manage = can('model-router:manage');
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.policy);

  return (
    <Page>
      <PageHeader
        title="Model Router"
        subtitle="Use frontier reasoning where it changes the outcome, and cheaper models for bounded execution"
        actions={
          manage ? (
            <button
              className="btn"
              disabled={!dirty || saving}
              onClick={() => void save({
                expectedRevision: snapshot.policy.revision,
                enabled: draft.enabled,
                profiles: draft.profiles,
                rules: draft.rules,
              })}
            >
              {saving ? 'Saving…' : 'Save policy'}
            </button>
          ) : undefined
        }
      />
      <ErrorBar error={error} />

      <ListCard subtle ariaLabel="Model Router status">
        <SettingRow
          className="px-4 py-3"
          title="Stage-aware routing"
          description="Explicit model → card preference → Model Router → lane/task defaults. Disabling restores the existing cascade."
        >
          <Switch
            label="Enable Model Router"
            checked={draft.enabled}
            disabled={!manage}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />
        </SettingRow>
      </ListCard>

      {snapshot.models.length === 0 ? (
        <div className="banner-info" role="status">
          No shared machine currently advertises a model. Configure model endpoints and runner access before enabling profiles.
        </div>
      ) : null}

      <Section title="Quality and cost profiles">
        <div className="grid gap-4 xl:grid-cols-2">
          {draft.profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              models={snapshot.models}
              manage={manage}
              onChange={(next) => setDraft({
                ...draft,
                profiles: draft.profiles.map((item) => item.id === next.id ? next : item),
              })}
            />
          ))}
        </div>
      </Section>

      <Section title="Workflow routes">
        <ListCard subtle ariaLabel="Workflow routing rules">
          {draft.rules.map((rule) => (
            <div key={rule.id} className="px-4 py-3">
              <SettingRow title={rule.label} description={`${rule.task} · ${rule.phase}`}>
                <div className="flex items-center gap-3">
                  <select
                    className="input input-sm w-44"
                    aria-label={`Profile for ${rule.label}`}
                    value={rule.profileId}
                    disabled={!manage}
                    onChange={(event) => setDraft({
                      ...draft,
                      rules: draft.rules.map((item) => item.id === rule.id
                        ? { ...item, profileId: event.target.value as ModelRouterProfileId }
                        : item),
                    })}
                  >
                    {draft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                  </select>
                  <Switch
                    label={`Enable ${rule.label}`}
                    checked={rule.enabled}
                    disabled={!manage}
                    onChange={(enabled) => setDraft({
                      ...draft,
                      rules: draft.rules.map((item) => item.id === rule.id ? { ...item, enabled } : item),
                    })}
                  />
                </div>
              </SettingRow>
            </div>
          ))}
        </ListCard>
      </Section>

      <Section title="Recent routing decisions">
        {snapshot.decisions.length === 0 ? (
          <EmptyState title="No routed runs yet" hint="Decisions appear after an enabled rule matches a run phase." />
        ) : (
          <ListCard subtle ariaLabel="Recent routing decisions">
            {snapshot.decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} />)}
          </ListCard>
        )}
      </Section>

      <Section title="Cost per work unit">
        {snapshot.workUnits.length === 0 ? (
          <EmptyState title="No multi-run workflows yet" hint="Ideas, board cards and reviews roll up here by their shared work-unit id." />
        ) : (
          <ListCard subtle ariaLabel="Recent work unit costs">
            {snapshot.workUnits.map((unit) => (
              <div key={unit.id} className="px-4 py-3">
                <SettingRow
                  title={unit.id}
                  description={`${unit.runs} run(s) · ${(unit.inputTokens + unit.outputTokens).toLocaleString()} tokens · ${unit.partial ? 'at least ' : ''}${formatCost(unit.estimatedCostUsd)} · ${timeAgo(unit.lastAt)}`}
                />
              </div>
            ))}
          </ListCard>
        )}
      </Section>
    </Page>
  );
}

function ProfileCard({ profile, models, manage, onChange }: {
  readonly profile: ModelRouterProfile;
  readonly models: readonly ModelRouterModelOption[];
  readonly manage: boolean;
  readonly onChange: (profile: ModelRouterProfile) => void;
}): React.JSX.Element {
  const available = models.filter((model) => !profile.models.includes(model.id));
  return (
    <div className="card p-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-[var(--text)]">{profile.label}</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">{profile.description}</p>
        </div>
        <select
          className="input input-sm w-32"
          aria-label={`Unavailable behavior for ${profile.label}`}
          value={profile.unavailable}
          disabled={!manage}
          onChange={(event) => onChange({
            ...profile,
            unavailable: event.target.value === 'fail' ? 'fail' : 'fallback',
          })}
        >
          <option value="fallback">Fall back</option>
          <option value="fail">Fail closed</option>
        </select>
      </div>
      <div className="mt-3 space-y-2">
        {profile.models.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No models selected — this profile is inactive.</p>
        ) : profile.models.map((model, index) => (
          <div key={model} className="flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{index + 1}. {model}</span>
            {manage ? (
              <>
                <button type="button" className="btn-ghost h-8 px-2" aria-label={`Move ${model} up`} disabled={index === 0} onClick={() => onChange({ ...profile, models: move(profile.models, index, -1) })}>↑</button>
                <button type="button" className="btn-ghost h-8 px-2" aria-label={`Move ${model} down`} disabled={index === profile.models.length - 1} onClick={() => onChange({ ...profile, models: move(profile.models, index, 1) })}>↓</button>
                <button type="button" className="btn-ghost h-8 px-2" onClick={() => onChange({ ...profile, models: profile.models.filter((item) => item !== model) })}>Remove</button>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {manage && available.length > 0 ? (
        <select
          className="input input-sm mt-3 w-full"
          aria-label={`Add model to ${profile.label}`}
          value=""
          onChange={(event) => {
            if (event.target.value) onChange({ ...profile, models: [...profile.models, event.target.value] });
          }}
        >
          <option value="">Add fallback candidate…</option>
          {available.map((model) => <option key={model.id} value={model.id}>{model.id} · {model.machines} machine(s)</option>)}
        </select>
      ) : null}
    </div>
  );
}

function DecisionRow({ decision }: { readonly decision: ModelRouterDecision }): React.JSX.Element {
  const tokens = decision.inputTokens === null
    ? 'usage pending'
    : `${(decision.inputTokens + (decision.outputTokens ?? 0)).toLocaleString()} tokens`;
  const cost = decision.estimatedCostUsd === null ? '' : ` · ${formatCost(decision.estimatedCostUsd)}`;
  return (
    <div className="px-4 py-3">
      <SettingRow
        title={`${decision.task} · ${decision.phase}`}
        description={`${decision.outcome} · policy v${decision.policyRevision} · ${tokens}${cost} · ${timeAgo(decision.createdAt)}`}
      >
        <a className="text-sm underline" href={`#/runs/${encodeURIComponent(decision.runId)}`}>
          {decision.selectedModel ?? 'runtime default'}
        </a>
      </SettingRow>
    </div>
  );
}

function move(models: readonly string[], index: number, delta: -1 | 1): readonly string[] {
  const next = [...models];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function formatCost(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
