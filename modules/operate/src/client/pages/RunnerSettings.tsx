import { useState, type FormEvent } from 'react';
import {
  Breadcrumb,
  EmptyState,
  ErrorBar,
  ListCard,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  SettingRow,
} from '@moxxy/companion-ui';
import { isAmbiguousWorkspaceName } from '@companion/module-workspace/client';
import { useAuth } from '@companion/module-core/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RunnerRecord, RunnerScope, RunTaskDescriptor } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunners } from '../hooks/useRunners.js';
import { DOT_TONE, normalizeEndpoint, TasksEditor, TokenHelp } from './Runners.js';

/**
 * A machine's settings page. The Edit modal outgrew itself once task filters
 * joined connection + placement, so each concern is its own `Section` +
 * compact settings rows, matching the app's settings pages. One form, one Save
 * (in the header); health stays live via the runners broadcast. Another user's
 * private runner reads as not found; shared runners remain visible but only
 * admins can enter this form.
 *
 * What a machine may serve is Providers' business, and which model each unit of
 * work uses is Task models': a machine carries capability and placement, never
 * model policy.
 */
export function RunnerSettingsPage({ id }: { id: string }): JSX.Element {
  const { runners, tasks, workspaces, error, setError, refresh } = useRunners();
  const { user, can } = useAuth();
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
  const manageable = runner.ownerId === user?.username || (runner.ownerId === null && can('runners:manage'));
  if (!manageable) {
    return (
      <Page>
        <EmptyState
          title="Shared machine"
          hint="This runner is available for your work, but only an admin can change its settings."
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
  const [blockedTasks, setBlockedTasks] = useState<readonly string[]>(runner.blockedTasks ?? []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;
  const capacity = Number(maxRuns);
  const { health } = runner;
  const dirty =
    name.trim() !== runner.name ||
    scope !== runner.scope ||
    !sameStrings(scope === 'delegated' ? workspaceIds : [], runner.workspaceIds) ||
    capacity !== runner.maxRuns ||
    !sameStrings(blockedTasks, runner.blockedTasks ?? []) ||
    (!local && (normalizeEndpoint(endpoint) !== runner.endpoint || token.trim().length > 0));

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

  return (
    <Page>
      <Breadcrumb className="mb-2" items={[{ label: 'Runners', href: '#/runners' }, { label: runner.name }]} />
      <PageHeader
        title={runner.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <MetaSignal
              tone={DOT_TONE[health.status]}
              label={health.status}
              pulse={health.liveRuns > 0}
              title={health.detail ?? undefined}
            />
            <span className="chip">{runner.ownerId === null ? 'shared' : 'private'}</span>
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
              disabled={
                !dirty || busy || name.trim().length < 2 || delegatedEmpty || !(capacity >= 1) || (!local && !endpoint.trim())
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      />
      <ErrorBar error={error} />

      <form id="runner-settings" onSubmit={(e) => void save(e)}>
        <Section title="Connection" description="How companiond reaches this machine.">
          <ListCard subtle>
            <SettingRow
              className="px-4 py-3"
              title="Name"
              description="The label shown in placement controls and run details."
            >
              <input
                className="input w-full sm:w-72"
                aria-label="Runner name"
                required
                minLength={2}
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </SettingRow>
            {local ? (
              <SettingRow
                className="px-4 py-3"
                title="Connection"
                description="Runs in-process on companiond's machine; it has no endpoint or bearer token."
              >
                <span className="chip">built in</span>
              </SettingRow>
            ) : (
              <>
                <SettingRow
                  className="px-4 py-3"
                  title="Endpoint"
                  description="companion-runner address; plain host:port uses http."
                >
                  <input
                    className="input w-full sm:w-72"
                    aria-label="Runner endpoint"
                    type="text"
                    required
                    placeholder="192.168.1.42:8920"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </SettingRow>
                <SettingRow
                  className="items-start px-4 py-3"
                  title="Bearer token"
                  description="Write-only credential used to authenticate this daemon to the runner."
                >
                  <div className="w-full sm:w-72">
                    <input
                      className="input"
                      aria-label="Runner bearer token"
                      type="password"
                      placeholder="Leave blank to keep current"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <TokenHelp />
                  </div>
                </SettingRow>
              </>
            )}
          </ListCard>
        </Section>

        <Section title="Work placement" description="Where this machine participates and how much work it accepts.">
          <ListCard subtle>
            <SettingRow
              className="items-start px-4 py-3"
              title="Workspace reach"
              description="Visibility is set by ownership; this only limits which workspaces may place runs here."
            >
              <fieldset className="grid w-full gap-2 sm:w-[30rem] sm:grid-cols-2">
                <legend className="sr-only">Workspace reach</legend>
                <RadioCard
                  name="scope"
                  checked={scope === 'shared'}
                  onSelect={() => setScope('shared')}
                  title="All workspaces"
                  description="Any accessible workspace can place work here."
                />
                <RadioCard
                  name="scope"
                  checked={scope === 'delegated'}
                  onSelect={() => setScope('delegated')}
                  title="Selected workspaces"
                  description="Only the workspaces picked below."
                />
              </fieldset>
            </SettingRow>

            {scope === 'delegated' ? (
              <SettingRow
                className="items-start px-4 py-3"
                title="Workspaces"
                description="The runner remains private or shared according to its ownership above."
              >
                <div className="flex w-full flex-col gap-1 text-sm sm:w-[30rem]">
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
              </SettingRow>
            ) : null}

            <SettingRow
              className="px-4 py-3"
              title="Concurrent runs"
              description="Maximum agent runs this machine may execute at once."
            >
              <input
                className="input w-24"
                aria-label="Maximum concurrent runs"
                type="number"
                min={1}
                max={64}
                required
                value={maxRuns}
                onChange={(e) => setMaxRuns(e.target.value)}
              />
            </SettingRow>
          </ListCard>
        </Section>

        <Section
          title="Tasks"
          description="Untick work this machine shouldn't take — say, board workers on a weaker laptop. If no machine accepts a task, the local runner takes it as a last resort."
        >
          <ListCard subtle>
            <div className="px-4 py-3">
              <TasksEditor tasks={tasks} blocked={blockedTasks} onChange={setBlockedTasks} />
            </div>
          </ListCard>
        </Section>
      </form>
    </Page>
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
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
