import { useState } from 'react';
import {
  Breadcrumb,
  EmptyState,
  ErrorBar,
  Field,
  Page,
  PageHeader,
  PageLoading,
  StatusDot,
  Tooltip,
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
 * model pins joined connection + placement, so each concern gets its own card
 * here. One form, one Save (in the header); health stays live via the runners
 * broadcast. A runner outside the viewer's reach reads as not found, matching
 * the API's owner masking.
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

  const save = async (e: React.FormEvent): Promise<void> => {
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
      setNote('Saved.');
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
          <span className="flex items-center gap-2">
            <Tooltip content={health.detail ?? health.status}>
              <StatusDot tone={DOT_TONE[health.status]} pulse={health.liveRuns > 0} label={health.status} />
            </Tooltip>
            {local ? 'this machine' : (runner.endpoint ?? 'remote')}
            <span className="tabular-nums">
              · {health.liveRuns} / {runner.maxRuns} running
            </span>
          </span>
        }
        actions={
          <>
            {note ? (
              <span role="status" className="dim text-xs">
                {note}
              </span>
            ) : null}
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

      <form id="runner-settings" onSubmit={(e) => void save(e)} className="grid items-start gap-4 lg:grid-cols-2">
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-medium">Connection</h2>
          <Field label="Name">
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
            <p className="dim text-xs">The built-in runner — companiond's own machine. No endpoint or token.</p>
          ) : (
            <>
              <Field
                label="Endpoint — companion-runner agent address"
                hint={
                  <>
                    Plain <code className="code-inline">host:port</code> or <code className="code-inline">ip:port</code>{' '}
                    works — http is assumed unless you write <code className="code-inline">https://</code>.
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
              <Field label="Bearer token">
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
        </section>

        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-medium">Placement</h2>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="dim mb-1 text-sm">Availability</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="scope" checked={scope === 'shared'} onChange={() => setScope('shared')} />
              Shared
              <span className="dim text-xs">— any workspace can place work here</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="scope" checked={scope === 'delegated'} onChange={() => setScope('delegated')} />
              Delegated
              <span className="dim text-xs">— only the workspaces picked below</span>
            </label>
          </fieldset>
          {scope === 'delegated' ? (
            <fieldset className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <legend className="dim px-1">Workspaces</legend>
              {workspaces.length === 0 ? <span className="dim">No workspaces found.</span> : null}
              {workspaces.map((w) => (
                <label key={w.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={workspaceIds.includes(w.id)}
                    onChange={(e) =>
                      setWorkspaceIds((prev) =>
                        e.target.checked ? [...prev, w.id] : prev.filter((id) => id !== w.id),
                      )
                    }
                  />
                  {w.name}
                  {isAmbiguousWorkspaceName(w, workspaces) ? <span className="dim text-xs">{w.slug}</span> : null}
                </label>
              ))}
            </fieldset>
          ) : null}
          <Field label="Max concurrent runs">
            <input
              className="input w-28"
              type="number"
              min={1}
              max={99}
              required
              value={maxRuns}
              onChange={(e) => setMaxRuns(e.target.value)}
            />
          </Field>
        </section>

        <section className="card">
          <TasksEditor tasks={tasks} blocked={blockedTasks} onChange={setBlockedTasks} />
        </section>

        <section className="card flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Model pins</h2>
            <button type="button" className="btn-ghost" disabled={fetching} onClick={() => void fetchModels()}>
              {fetching ? 'Fetching…' : 'Fetch models'}
            </button>
          </div>
          <p className="dim text-xs">
            Bind each action to a model this machine can serve. Unpinned actions ride its own default.
          </p>
          {pinsNote ? <p className="dim text-xs">{pinsNote}</p> : null}
          <ModelPinsEditor catalog={catalog} pins={modelPins} onChange={setModelPins} />
        </section>
      </form>
    </Page>
  );
}
