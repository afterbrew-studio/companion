import { useState, type FormEvent, type ReactNode } from 'react';
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
  timeAgo,
} from '@moxxy/companion-ui';
import { isAmbiguousWorkspaceName } from '@companion/module-workspace/client';
import { useAuth } from '@companion/module-core/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type {
  RunnerPolicyOptions,
  RunnerRecord,
  RunnerRepoScope,
  RunnerScope,
  RunnerTaskPolicy,
} from '../../contract/index.js';
import { OPEN_TASK_POLICY } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunnerOptions } from '../hooks/useRunnerOptions.js';
import { useRunners } from '../hooks/useRunners.js';
import { convertPolicyMode, TaskPolicyEditor } from '../components/TaskPolicyEditor.js';
import { DOT_TONE, normalizeEndpoint, TokenHelp } from './Runners.js';

/**
 * A machine's settings page, laid out as the three different things a runner
 * row actually holds, because they read differently and one of them is not a
 * setting at all:
 *
 *  - **Machine** — how companiond reaches it, and how much it may run at once.
 *    Capacity belongs to the machine, not to where it participates.
 *  - **Capability** — what probing FOUND. Read-only by construction: nobody
 *    chose it, so nothing here is a control.
 *  - **Policy** — what it is allowed to be used for, as a mode plus a
 *    module/task tree. The mode is the load-bearing part: a deny-list is open
 *    to whatever the next module update registers, an allow-list is not.
 *  - **Placement** — where it participates: workspaces, repositories, roles.
 *
 * One form, one Save (in the header); health stays live via the runners
 * broadcast. Another user's private runner reads as not found; shared runners
 * remain visible but only admins can enter this form.
 *
 * What a machine may SERVE is Providers' business, and which model each unit of
 * work uses is Task models': a machine carries capability and policy, never
 * model policy.
 */
export function RunnerSettingsPage({ id }: { id: string }): JSX.Element {
  const { runners, workspaces, error, setError, refresh } = useRunners();
  const options = useRunnerOptions();
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
    <SettingsForm
      runner={runner}
      options={options}
      workspaces={workspaces}
      error={error}
      setError={setError}
      refresh={refresh}
    />
  );
}

/** Separate component so form state seeds once the runner row exists. */
function SettingsForm({
  runner,
  options,
  workspaces,
  error,
  setError,
  refresh,
}: {
  runner: RunnerRecord;
  options: RunnerPolicyOptions;
  workspaces: readonly WorkspaceRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}): JSX.Element {
  const local = runner.kind === 'local';
  // A daemon still serving the previous dist during a restart omits the policy
  // fields; seed from the open default rather than blanking the form.
  const saved = {
    taskPolicy: runner.taskPolicy ?? OPEN_TASK_POLICY,
    repoIds: runner.repoIds ?? [],
    allowedRoles: runner.allowedRoles ?? [],
  };
  const [name, setName] = useState(runner.name);
  const [endpoint, setEndpoint] = useState(runner.endpoint ?? '');
  const [token, setToken] = useState('');
  const [maxRuns, setMaxRuns] = useState(String(runner.maxRuns));
  const [scope, setScope] = useState<RunnerScope>(runner.scope);
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>(runner.workspaceIds);
  const [repoScope, setRepoScope] = useState<RunnerRepoScope>(runner.repoScope ?? 'all');
  const [repoIds, setRepoIds] = useState<readonly string[]>(saved.repoIds);
  const [allowedRoles, setAllowedRoles] = useState<readonly string[]>(saved.allowedRoles);
  const [roleScoped, setRoleScoped] = useState(saved.allowedRoles.length > 0);
  const [policy, setPolicy] = useState<RunnerTaskPolicy>(saved.taskPolicy);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const shared = runner.ownerId === null;
  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;
  const reposEmpty = repoScope === 'selected' && repoIds.length === 0;
  const rolesEmpty = roleScoped && allowedRoles.length === 0;
  const nextRoles = shared && roleScoped ? allowedRoles : [];
  const capacity = Number(maxRuns);
  const { health, catalog } = runner;
  const dirty =
    name.trim() !== runner.name ||
    capacity !== runner.maxRuns ||
    scope !== runner.scope ||
    !sameStrings(scope === 'delegated' ? workspaceIds : [], runner.workspaceIds) ||
    repoScope !== (runner.repoScope ?? 'all') ||
    !sameStrings(repoScope === 'selected' ? repoIds : [], saved.repoIds) ||
    !sameStrings(nextRoles, saved.allowedRoles) ||
    !samePolicy(policy, saved.taskPolicy) ||
    (!local && (normalizeEndpoint(endpoint) !== runner.endpoint || token.trim().length > 0));

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (delegatedEmpty) return setError('A delegated runner needs at least one workspace.');
    if (reposEmpty) return setError('Pick at least one repository, or clear the machine for all of them.');
    if (rolesEmpty) return setError('Pick at least one role, or open the machine to every role.');
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.updateRunner(runner.id, {
        name: name.trim(),
        maxRuns: capacity,
        scope,
        workspaceIds: scope === 'delegated' ? workspaceIds : [],
        repoScope,
        repoIds: repoScope === 'selected' ? repoIds : [],
        allowedRoles: nextRoles,
        taskPolicy: policy,
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

  const modelCount = new Set((catalog?.providers ?? []).flatMap((p) => p.models.map((m) => m.id))).size;

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
            <span className="chip">{shared ? 'shared' : 'private'}</span>
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
                !dirty ||
                busy ||
                name.trim().length < 2 ||
                delegatedEmpty ||
                reposEmpty ||
                rolesEmpty ||
                !(capacity >= 1) ||
                (!local && !endpoint.trim())
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      />
      <ErrorBar error={error} />

      <form id="runner-settings" onSubmit={(e) => void save(e)}>
        <Section title="Machine" description="How companiond reaches this machine, and how much it may run at once.">
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
          title="Capability"
          description="What this machine reported when the daemon last probed it. Nothing here is a setting — it is what the machine can do."
        >
          <ListCard subtle>
            <SettingRow className="px-4 py-3" title="Status" description={health.detail ?? undefined}>
              <span className="flex items-center gap-2">
                <MetaSignal tone={DOT_TONE[health.status]} label={health.status} />
                {health.lastSeenAt ? <span className="dim text-xs">seen {timeAgo(health.lastSeenAt)}</span> : null}
              </span>
            </SettingRow>
            <SettingRow
              className="px-4 py-3"
              title="moxxy"
              description={health.moxxyCompatible ? 'Recent enough for this daemon.' : 'Missing or older than this daemon needs.'}
            >
              <span className="dim text-sm">{health.moxxyVersion ?? 'unknown'}</span>
            </SettingRow>
            <SettingRow
              className="px-4 py-3"
              title="Model providers"
              description="Credentials configured on the machine. Which of them agents may use is set under Providers."
            >
              <span className="dim text-sm">
                {health.providers === null
                  ? 'not probed yet'
                  : health.providers.length > 0
                    ? health.providers.join(' · ')
                    : 'none configured'}
              </span>
            </SettingRow>
            <SettingRow
              className="px-4 py-3"
              title="Models"
              description={
                catalog ? `Read from this machine ${timeAgo(catalog.fetchedAt)}.` : 'This machine reports its models on its own, usually within a minute of connecting.'
              }
            >
              <span className="dim text-sm tabular-nums">{catalog ? modelCount : '—'}</span>
            </SettingRow>
          </ListCard>
        </Section>

        <Section
          title="Policy"
          description="What this machine may be used for. A module covers everything it registers now and in future; open it to decide task by task."
        >
          <ListCard subtle>
            <SettingRow
              className="items-start px-4 py-3"
              title="Default answer"
              description="What happens to a unit of work the list below does not mention — including work a future module update introduces."
            >
              <fieldset className="grid w-full gap-2 sm:w-[30rem] sm:grid-cols-2">
                <legend className="sr-only">Policy mode</legend>
                {/* Switching rewrites the list against the registered work, so
                    it must not run before that work has loaded. */}
                <RadioCard
                  name="policy-mode"
                  checked={policy.mode === 'deny'}
                  disabled={options.groups.length === 0}
                  onSelect={() => setPolicy((prev) => convertPolicyMode(prev, options.groups, 'deny'))}
                  title="Everything except"
                  description="Takes any work, minus what you untick. New tasks arrive allowed."
                />
                <RadioCard
                  name="policy-mode"
                  checked={policy.mode === 'allow'}
                  disabled={options.groups.length === 0}
                  onSelect={() => setPolicy((prev) => convertPolicyMode(prev, options.groups, 'allow'))}
                  title="Only these"
                  description="Takes nothing but what you tick. New tasks arrive refused."
                />
              </fieldset>
            </SettingRow>
            <div className="px-4 py-3">
              <TaskPolicyEditor groups={options.groups} policy={policy} onChange={setPolicy} />
            </div>
          </ListCard>
          <p className="dim mt-2 text-xs">
            Switching the default rewrites the list to keep what this machine may do today; what changes is how tasks
            added later are answered.
          </p>
        </Section>

        <Section title="Placement" description="Where this machine participates. Visibility is set by ownership; these only limit what may be placed here.">
          <ListCard subtle>
            <ReachRow
              title="Workspace reach"
              description="Which workspaces may place runs here."
              legend="Workspace reach"
              name="scope"
              scoped={scope === 'delegated'}
              onScope={(on) => setScope(on ? 'delegated' : 'shared')}
              all={{ title: 'All workspaces', description: 'Any accessible workspace can place work here.' }}
              some={{ title: 'Selected workspaces', description: 'Only the workspaces picked below.' }}
            >
              <CheckList
                label="Workspaces"
                items={workspaces.map((w) => ({
                  id: w.id,
                  label: w.name,
                  note: isAmbiguousWorkspaceName(w, workspaces) ? w.slug : undefined,
                }))}
                selected={workspaceIds}
                onChange={setWorkspaceIds}
                empty="No workspaces found."
                warn={delegatedEmpty ? 'Pick at least one workspace.' : null}
              />
            </ReachRow>

            <ReachRow
              title="Repositories"
              description="Which repositories' work this machine is cleared for."
              legend="Repository reach"
              name="repo-scope"
              scoped={repoScope === 'selected'}
              onScope={(on) => setRepoScope(on ? 'selected' : 'all')}
              all={{ title: 'All repositories', description: 'Any repository in reach can be worked on here.' }}
              some={{
                title: 'Selected repositories',
                description: 'Only these. Work with no repository is placed elsewhere.',
              }}
            >
              <CheckList
                label="Repositories"
                items={options.repos.map((r) => ({ id: r.fullName, label: r.fullName }))}
                selected={repoIds}
                onChange={setRepoIds}
                empty="No repositories connected yet."
                warn={reposEmpty ? 'Pick at least one repository.' : null}
              />
            </ReachRow>

            {shared ? (
              <ReachRow
                title="Who may use it"
                description="Whose runs may land here. Automated work has no triggering role, so a restricted machine never receives it."
                legend="Roles"
                name="role-scope"
                scoped={roleScoped}
                onScope={setRoleScoped}
                all={{ title: 'Everyone', description: 'Any role that can reach this machine may place work.' }}
                some={{ title: 'Selected roles', description: 'Only users holding one of these roles.' }}
              >
                <CheckList
                  label="Roles"
                  items={options.roles.map((role) => ({ id: role, label: role }))}
                  selected={allowedRoles}
                  onChange={setAllowedRoles}
                  empty="No roles found."
                  warn={rolesEmpty ? 'Pick at least one role.' : null}
                />
              </ReachRow>
            ) : (
              <SettingRow
                className="px-4 py-3"
                title="Who may use it"
                description="This machine is private: only runs you trigger are ever placed on it."
              >
                <span className="chip">you only</span>
              </SettingRow>
            )}
          </ListCard>
        </Section>
      </form>
    </Page>
  );
}

/** The app's all-or-selected reach control: two option cards, then the picker. */
function ReachRow({
  title,
  description,
  legend,
  name,
  scoped,
  onScope,
  all,
  some,
  children,
}: {
  title: string;
  description: string;
  legend: string;
  name: string;
  scoped: boolean;
  onScope: (scoped: boolean) => void;
  all: { title: string; description: string };
  some: { title: string; description: string };
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="px-4 py-3">
      <SettingRow className="items-start" title={title} description={description}>
        <fieldset className="grid w-full gap-2 sm:w-[30rem] sm:grid-cols-2">
          <legend className="sr-only">{legend}</legend>
          <RadioCard name={name} checked={!scoped} onSelect={() => onScope(false)} {...all} />
          <RadioCard name={name} checked={scoped} onSelect={() => onScope(true)} {...some} />
        </fieldset>
      </SettingRow>
      {scoped ? <div className="mt-3 flex sm:justify-end">{children}</div> : null}
    </div>
  );
}

/** Scrollable tick-list backing a "selected" reach choice. */
function CheckList({
  label,
  items,
  selected,
  onChange,
  empty,
  warn,
}: {
  label: string;
  items: readonly { id: string; label: string; note?: string }[];
  selected: readonly string[];
  onChange: (next: readonly string[]) => void;
  empty: string;
  warn: string | null;
}): JSX.Element {
  return (
    <div className="flex w-full flex-col gap-1 text-sm sm:w-[30rem]">
      <div
        role="group"
        aria-label={label}
        className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800"
      >
        {items.length === 0 ? <span className="dim px-2 py-1.5">{empty}</span> : null}
        {items.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          >
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))
              }
            />
            <span className="flex-1 truncate">{item.label}</span>
            {item.note ? <span className="dim text-xs">{item.note}</span> : null}
          </label>
        ))}
      </div>
      {warn ? <span className="text-xs text-amber-600 dark:text-amber-400">{warn}</span> : null}
    </div>
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function samePolicy(a: RunnerTaskPolicy, b: RunnerTaskPolicy): boolean {
  return a.mode === b.mode && sameStrings(a.modules, b.modules) && sameStrings(a.tasks, b.tasks);
}

/** A bordered, selectable option card — the app's two-choice radio idiom. */
function RadioCard({
  name,
  checked,
  onSelect,
  title,
  description,
  disabled,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border p-3 transition-colors ${
        disabled ? 'opacity-60' : 'cursor-pointer'
      } ${
        checked
          ? 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-800/60'
          : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
      }`}
    >
      <input type="radio" name={name} className="mt-0.5" checked={checked} disabled={disabled} onChange={onSelect} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="dim block text-xs">{description}</span>
      </span>
    </label>
  );
}
