import { EmptyState, ErrorBar, ListCard, Page, PageHeader, PageLoading, Section, SettingRow } from '@moxxy/companion-ui';
import type { CatalogModel, TaskModelPin } from '../../contract/index.js';
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
export function TaskModelsPage(): JSX.Element {
  const { snapshot, error, saving, setPin } = useTaskModels();
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
        subtitle={`Bind a kind of agent work to a model. Anything left unpinned rides ${snapshot.defaultModel || 'the daemon default'}`}
      />
      <ErrorBar error={error} />

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
              No shared machine can serve a model right now, so there is nothing new to pin to.{' '}
              <a className="underline" href="#/providers">
                Configure a provider
              </a>
              .
            </div>
          ) : null}
          {ordered.map(([moduleId, group]) => (
            <Section key={moduleId} title={group.title}>
              <ListCard subtle ariaLabel={`${group.title} tasks`}>
                {group.tasks.map((entry) => (
                  <div key={entry.task.id} className="px-4 py-3">
                    <SettingRow title={entry.task.label} description={entry.task.hint ?? entry.task.id}>
                      <ModelPicker
                        entry={entry}
                        models={snapshot.models}
                        defaultModel={snapshot.defaultModel}
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

function ModelPicker({
  entry,
  models,
  defaultModel,
  busy,
  onChange,
}: {
  entry: TaskModelPin;
  models: readonly CatalogModel[];
  defaultModel: string;
  busy: boolean;
  onChange: (model: string | null) => void;
}): JSX.Element {
  // A pin nothing can serve right now is shown rather than silently read as
  // unpinned: the select would otherwise display "default" and the next edit
  // would quietly discard a choice the user still holds.
  const stale = entry.model !== null && !models.some((m) => m.id === entry.model);
  return (
    <select
      className="input input-sm w-56 shrink-0"
      aria-label={`Model for ${entry.task.label}`}
      disabled={busy}
      value={entry.model ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
      {stale ? <option value={entry.model!}>{entry.model} (unavailable now)</option> : null}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
          {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}
        </option>
      ))}
    </select>
  );
}
