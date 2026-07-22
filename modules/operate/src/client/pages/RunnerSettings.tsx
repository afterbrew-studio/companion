import { useState, type FormEvent } from 'react';
import {
  Breadcrumb,
  EmptyState,
  ErrorBar,
  Field,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Section,
} from '@companion/ui';
import { isAmbiguousWorkspaceName } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type {
  RunnerCatalog,
  RunnerModelPins,
  RunnerRecord,
  RunnerScope,
  RunTaskDescriptor,
} from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunners } from '../hooks/useRunners.js';
import { DOT_TONE, ModelPinsEditor, normalizeEndpoint, TasksEditor, TokenHelp } from './Runners.js';

/**
 * A machine's settings page — the Edit modal outgrew itself once tasks and
 * model pins joined connection + placement, so each concern is its own
 * `Section` + card in a single column, matching the app's settings pages. One
 * form, one Save (in the header); health stays live via the runners broadcast.
 * A runner outside the viewer's reach reads as not found, matching the API's
 * owner masking.
 */
export function RunnerSettingsPage({ id }: { id: string }): JSX.Element {
  const { runners, tasks, workspaces, error, setError, refresh } = useRunners();
  if (runners === null) return <PageLoading label="Loading machine…" />;
  const runner = runners.find((r) => r.id === id);
  if (!runner) {
    return (
      <Page>
        <EmptyState
          title="Machine not found"
          hint="It may have been deleted, or it belongs to someone else."
          action={
            <a className="btn-ghost" href="#/runners">
              Back to runners
            </a>
          }
        />
      </Page>
    );
  }
  return (
    <SettingsForm runner={runner} tasks={tasks} workspaces={workspaces} error={error} setError={setError} refresh={refresh} />
  );
}

/** Separate component so form state seeds once the runner row exists. */
function SettingsForm({
  runner,
  tasks,
  workspaces,
  error,
  setError,
  refresh,
}: {
  runner: RunnerRecord;
  tasks: readonly RunTaskDescriptor[];
  workspaces: readonly WorkspaceRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}): JSX.Element {
  const local = runner.kind === 'local';
  const [name, setName] = useState(runner.name);
  const [endpoint, setEndpoint] = useState(runner.endpoint ?? '');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState<RunnerScope>(runner.scope);
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>(runner.workspaceIds);
  const [maxRuns, setMaxRuns] = useState(String(runner.maxRuns));
  const [modelPins, setModelPins] = useState<RunnerModelPins>(runner.modelPins);
  const [blockedTasks, setBlockedTasks] = useState<readonly string[]>(runner.blockedTasks ?? []);
  const [catalog, setCatalog] = useState<RunnerCatalog | null>(runner.catalog);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pinsNote, setPinsNote] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;
  const capacity = Number(maxRuns);
  const { health } = runner;

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (delegatedEmpty) {
      setError('A delegated runner needs at least one workspace.');
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.updateRunner(runner.id, {
        name: name.trim(),
        scope,
        workspaceIds: scope === 'delegated' ? workspaceIds : [],
        maxRuns: capacity,
        modelPins,
        blockedTasks,
        ...(local ? {} : { endpoint: normalizeEndpoint(endpoint), ...(token.trim() ? { token: token.trim() } : {}) }),
      });
      setToken('');
      await refresh();
      setNote('Saved');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // Probe the machine and pull its model catalog into the pin dropdowns.
  // Doubles as a reachability check — the note reports what came back.
  const fetchModels = async (): Promise<void> => {
    setFetching(true);
    setPinsNote(null);
    try {
      const result = await api.probeRunner(runner.id);
      setCatalog(result.catalog);
      const ready = (result.catalog?.providers ?? []).filter((p) => p.ready);
      const modelCount = new Set(ready.flatMap((p) => p.models.map((m) => m.id))).size;
      setPinsNote(
        !result.ok
          ? (result.health.detail ?? 'unreachable')
          : modelCount > 0
            ? `${modelCount} model${modelCount === 1 ? '' : 's'} from ${ready.length} provider${ready.length === 1 ? '' : 's'}.`
            : 'Reachable, but no provider with credentials was found on this machine.',
      );
    } catch (err) {
      setPinsNote(String(err));
    } finally {
      setFetching(false);
    }
  };

  return (
    <Page>
      <Breadcrumb className="mb-2" items={[{ label: 'Runners', href: '#/runners' }, { label: runner.name }]} />
      <PageHeader
        title={runner.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MetaSignal
              tone={DOT_TONE[health.status]}
              label={health.status}
              pulse={health.liveRuns > 0}
              title={health.detail ?? undefined}
            />
            <span>{local ? 'this machine' : (runner.endpoint ?? 'remote')}</span>
            <span className="tabular-nums">
              {health.liveRuns} / {runner.maxRuns} running
            </span>
          </span>
        }
        actions={
          <>
            {note ? <MetaSignal tone="green" label={note} /> : null}
            <button
              className="btn"
              type="submit"
              form="runner-settings"
              disabled={busy || name.trim().length < 2 || delegatedEmpty || !(capacity >= 1) || (!local && !endpoint.trim())}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      />
      <ErrorBar error={error} />

      <form id="runner-settings" onSubmit={(e) => void save(e)}>
        <Section title="Connection" description="How companiond reaches this machine.">
          <div className="card flex flex-col gap-4">
            <Field label="Name" className="max-w-md">
              <input
                className="input"
                required
                minLength={2}
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {local ? (
              <p className="dim text-[13px]">The built-in runner — companiond&apos;s own machine. No endpoint or token.</p>
            ) : (
              <>
                <Field
                  label="Endpoint — companion-runner agent address"
                  className="max-w-md"
                  hint={
                    <>
                      Plain <code className="code-inline">host:port</code> or{' '}
                      <code className="code-inline">ip:port</code> works — http is assumed unless you write{' '}
                      <code className="code-inline">https://</code>.
                    </>
                  }
                >
                  <input
                    className="input"
                    type="text"
                    required
                    placeholder="192.168.1.42:8920"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </Field>
                <Field label="Bearer token" className="max-w-md">
                  <input
                    className="input"
                    type="password"
                    placeholder="leave blank to keep current"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <TokenHelp />
                </Field>
              </>
            )}
          </div>
        </Section>

        <Section title="Placement" description="Which workspaces can run work here, and how many at once.">
          <div className="card flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="dim mb-1.5 text-[13px]">Availability</legend>
              <div className="grid max-w-xl gap-2 sm:grid-cols-2">
                <RadioCard
                  name="scope"
                  checked={scope === 'shared'}
                  onSelect={() => setScope('shared')}
                  title="Shared"
                  description="Any workspace can place work here."
                />
                <RadioCard
                  name="scope"
                  checked={scope === 'delegated'}
                  onSelect={() => setScope('delegated')}
                  title="Delegated"
                  description="Only the workspaces you pick below."
                />
              </div>
            </fieldset>

            {scope === 'delegated' ? (
              <div className="flex max-w-md flex-col gap-1 text-sm">
                <span className="dim">Workspaces</span>
                <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {workspaces.length === 0 ? (
                    <span className="dim px-2 py-1.5">No workspaces found.</span>
                  ) : null}
                  {workspaces.map((w) => (
                    <label
                      key={w.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                    >
                      <input
                        type="checkbox"
                        checked={workspaceIds.includes(w.id)}
                        onChange={(e) =>
                          setWorkspaceIds((prev) =>
                            e.target.checked ? [...prev, w.id] : prev.filter((id) => id !== w.id),
                          )
                        }
                      />
                      <span className="flex-1">{w.name}</span>
                      {isAmbiguousWorkspaceName(w, workspaces) ? <span className="dim text-xs">{w.slug}</span> : null}
                    </label>
                  ))}
                </div>
                {delegatedEmpty ? (
                  <span className="text-xs text-amber-600 dark:text-amber-400">Pick at least one workspace.</span>
                ) : null}
              </div>
            ) : null}

            <Field label="Max concurrent runs">
              <input
                className="input w-24"
                type="number"
                min={1}
                max={99}
                required
                value={maxRuns}
                onChange={(e) => setMaxRuns(e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Tasks"
          description="Untick work this machine shouldn't take — say, board workers on a weaker laptop. If no machine accepts a task, the local runner takes it as a last resort."
        >
          <div className="card">
            <TasksEditor tasks={tasks} blocked={blockedTasks} onChange={setBlockedTasks} />
          </div>
        </Section>

        <Section
          title="Model pins"
          description="Bind each action to a model this machine can serve. Unpinned actions ride its own default."
        >
          <div className="card flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="dim text-xs">{pinsNote}</span>
              <button type="button" className="btn-ghost" disabled={fetching} onClick={() => void fetchModels()}>
                {fetching ? 'Fetching…' : 'Fetch models'}
              </button>
            </div>
            <ModelPinsEditor catalog={catalog} pins={modelPins} onChange={setModelPins} />
          </div>
        </Section>
      </form>
    </Page>
  );
}

/** A bordered, selectable option card — the app's two-choice radio idiom. */
function RadioCard({
  name,
  checked,
  onSelect,
  title,
  description,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}): JSX.Element {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${
        checked
          ? 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-800/60'
          : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
      }`}
    >
      <input type="radio" name={name} className="mt-0.5" checked={checked} onChange={onSelect} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="dim block text-xs">{description}</span>
      </span>
    </label>
  );
}
