import { useEffect, useState } from 'react';
import { EmptyState, ErrorBar, ListCard, Page, PageHeader, PageLoading, Section, SettingRow, timeAgo } from '@moxxy/companion-ui';
import type { CatalogModel, RunLane, TaskModelPin } from '../../contract/index.js';
import { useTaskModels } from '../hooks/useTaskModels.js';

/**
 * Which model each unit of agent work rides. A task is what people actually
 * think in ("issue triage", "board workers"), and modules already register
 * theirs for placement, so the catalogue on this page is free and always
 * current. Pins are instance-wide: machines carry capability and placement,
 * never model policy.
 *
 * Only models the shared pool can serve are offered: pinning anything else
 * would fall back (or refuse) on every unattended run of that task. The
 * Providers page is where that set is widened.
 */
export function TaskModelsPage({ query }: { query?: URLSearchParams }): React.JSX.Element {
  // Which layer is being edited. Instance governs unattended work; a lane
  // governs what a person starts while that lane is selected. Seeded from the
  // link so the picker's per-runtime cog lands on the right one.
  const [lane, setLane] = useState<RunLane | null>(() => {
    const runnerId = query?.get('runner');
    const harness = query?.get('harness');
    return runnerId && harness ? { runnerId, harness } : null;
  });
  // The page stays mounted while the hash changes, so seeding state once is
  // not enough: arriving from another runtime's cog would keep showing the
  // previous one.
  const linked = `${query?.get('runner') ?? ''}:${query?.get('harness') ?? ''}`;
  useEffect(() => {
    const [runnerId, harness] = linked.split(':');
    setLane(runnerId && harness ? { runnerId, harness } : null);
  }, [linked]);

  const { snapshot, error, saving, setPin, setLaneDefault } = useTaskModels(lane ?? undefined);
  if (snapshot === null) return <PageLoading label="Loading tasks…" />;

  // Grouped by owning module, modules alphabetical (a settings page should sit
  // still); tasks keep the server's order within a group.
  const groups = new Map<string, { title: string; tasks: TaskModelPin[] }>();
  for (const entry of snapshot.tasks) {
    const group = groups.get(entry.moduleId) ?? { title: entry.moduleTitle, tasks: [] };
    group.tasks.push(entry);
    groups.set(entry.moduleId, group);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) => a.title.localeCompare(b.title));

  return (
    <Page>
      <PageHeader
        title="Task models"
        subtitle="Bind a kind of agent work to a model, for every machine or for one machine and runtime"
      />
      <ErrorBar error={error} />

      <ListCard subtle ariaLabel="What these pins apply to">
        <SettingRow
          className="px-4 py-3"
          title="Applies to"
          description={
            lane
              ? 'What you start yourself while this lane is selected. Unattended work is unaffected.'
              : 'Every run with no lane of its own, which is all unattended work: webhooks, schedules, pipelines.'
          }
        >
          <select
            className="input input-sm w-72 shrink-0"
            aria-label="Layer to configure"
            value={lane ? `${lane.runnerId}:${lane.harness}` : ''}
            onChange={(e) => {
              const [runnerId, harness] = e.target.value.split(':');
              setLane(e.target.value === '' ? null : { runnerId: runnerId!, harness: harness! });
            }}
          >
            <option value="">All machines (unattended work)</option>
            {(snapshot.lanes ?? []).map((l) => (
              <option key={`${l.runnerId}:${l.harness}`} value={`${l.runnerId}:${l.harness}`}>
                {l.label}
              </option>
            ))}
          </select>
        </SettingRow>
        {lane ? (
          <SettingRow
            className="px-4 py-3"
            title="This lane's default"
            description="Used by every task below that has no pin of its own."
          >
            <select
              className="input input-sm w-56 shrink-0"
              aria-label="Lane default model"
              disabled={saving === '__lane_default__'}
              value={snapshot.laneDefaultModel ?? ''}
              onChange={(e) => void setLaneDefault(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">Auto — runtime default</option>
              {snapshot.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </SettingRow>
        ) : null}
      </ListCard>

      {snapshot.tasks.length === 0 ? (
        <EmptyState
          title="No tasks registered"
          hint="Tasks are declared by the modules that run agents. Enable a module under Modules and its work appears here."
        />
      ) : (
        <>
          {/* Rendered rather than replaced by an empty state: pins already set
              must stay visible (and clearable) when the pool goes quiet. */}
          {snapshot.models.length === 0 ? (
            <div className="banner-info" role="status">
              {lane ? (
                // Some runtimes resolve their model per session and publish no
                // list. Sending someone to Providers for that would be advice
                // that cannot work: there is no credential to add.
                <>This runtime does not report a model list, so there is nothing to pin here. Its runs use its own default.</>
              ) : (
                <>
                  No shared machine can serve a model right now, so there is nothing new to pin to.{' '}
                  <a className="underline" href="#/providers">
                    Configure a provider
                  </a>
                  .
                </>
              )}
            </div>
          ) : null}
          {ordered.map(([moduleId, group]) => (
            <Section key={moduleId} title={group.title}>
              <ListCard subtle ariaLabel={`${group.title} tasks`}>
                {group.tasks.map((entry) => (
                  <div key={entry.task.id} className="px-4 py-3">
                    <SettingRow
                      title={entry.task.label}
                      description={describe(entry, lane, snapshot.models)}
                    >
                      <ModelPicker
                        entry={entry}
                        lane={lane}
                        models={snapshot.models}
                        inherited={inheritedFor(
                          entry,
                          lane,
                          snapshot.laneDefaultModel ?? null,
                          snapshot.models,
                        )}
                        busy={saving === entry.task.id}
                        onChange={(model) => void setPin(entry.task.id, model)}
                      />
                    </SettingRow>
                  </div>
                ))}
              </ListCard>
            </Section>
          ))}
        </>
      )}
    </Page>
  );
}

/**
 * What this task would use if it had no pin here, and where that comes from.
 * Stated per row because a selector that silently changes which layer you are
 * editing is how someone sets a lane pin believing it was instance-wide.
 */
function inheritedFor(
  entry: TaskModelPin,
  lane: RunLane | null,
  laneDefault: string | null,
  servable: readonly CatalogModel[],
): string | null {
  if (!lane) return null;
  // The instance pin only reaches this lane if the lane can serve it. Naming a
  // model this runtime cannot run would promise an inheritance that dispatch
  // drops on every run.
  const reachable = entry.model !== null && servable.some((m) => m.id === entry.model) ? entry.model : null;
  return laneDefault ?? reachable;
}

/** The row's second line: what it inherits, and what actually last ran it. */
function describe(
  entry: TaskModelPin,
  lane: RunLane | null,
  servable: readonly CatalogModel[],
): string {
  const base = entry.task.hint ?? entry.task.id;
  const parts = [base];
  // Said in terms of what it governs rather than where it is stored: this is
  // the model unattended runs of this task take, and it is worth mentioning in
  // a lane only when that lane could also fall back to it.
  if (lane && entry.model && servable.some((m) => m.id === entry.model)) {
    parts.push(`unattended: ${entry.model}`);
  }
  if (!lane && !entry.model) {
    parts.push("auto: selected runtime's default");
  }
  if (entry.lastRun) {
    const model = entry.lastRun.model ?? 'that machine\u2019s default';
    parts.push(`last run: ${entry.lastRun.harness} \u00b7 ${model}, ${timeAgo(entry.lastRun.at)}`);
  }
  return parts.join(' \u00b7 ');
}

function ModelPicker({
  entry,
  lane,
  models,
  inherited,
  busy,
  onChange,
}: {
  entry: TaskModelPin;
  lane: RunLane | null;
  models: readonly CatalogModel[];
  inherited: string | null;
  busy: boolean;
  onChange: (model: string | null) => void;
}): React.JSX.Element {
  const pinned = lane ? (entry.laneModel ?? null) : entry.model;
  // A pin nothing can serve right now is shown rather than silently read as
  // unpinned: the select would otherwise display "default" and the next edit
  // would quietly discard a choice the user still holds.
  const stale = pinned !== null && !models.some((m) => m.id === pinned);
  return (
    <select
      className="input input-sm w-56 shrink-0"
      aria-label={`Model for ${entry.task.label}`}
      disabled={busy}
      value={pinned ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">{inherited ? `Auto — ${inherited}` : 'Auto — runtime default'}</option>
      {stale ? <option value={pinned!}>{pinned} (unavailable now)</option> : null}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
          {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}
        </option>
      ))}
    </select>
  );
}
