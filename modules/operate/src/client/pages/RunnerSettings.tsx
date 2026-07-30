import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Breadcrumb,
  EmptyState,
  ErrorBar,
  Field,
  ListCard,
  MetaSignal,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  SegmentedControl,
  SettingRow,
  timeAgo,
} from '@moxxy/companion-ui';
import { isAmbiguousWorkspaceName } from '@companion/module-workspace/client';
import { useAuth } from '@companion/module-core/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type {
  HarnessOption,
  RunnerPolicyOptions,
  RunnerRecord,
  RunnerRepoScope,
  RunnerScope,
  RunnerTaskPolicy,
} from '../../contract/index.js';
import { convertPolicyMode, OPEN_TASK_POLICY } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunnerOptions } from '../hooks/useRunnerOptions.js';
import { useRunners } from '../hooks/useRunners.js';
import { TaskPolicyEditor } from '../components/TaskPolicyEditor.js';
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
  const [harnesses, setHarnesses] = useState<readonly string[]>(runner.harnesses.map((h) => h.id));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);

  const shared = runner.ownerId === null;
  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;
  const reposEmpty = repoScope === 'selected' && repoIds.length === 0;
  const rolesEmpty = roleScoped && allowedRoles.length === 0;
  const harnessesEmpty = harnesses.length === 0;
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
    !sameStrings(harnesses, runner.harnesses.map((h) => h.id)) ||
    (!local && (normalizeEndpoint(endpoint) !== runner.endpoint || token.trim().length > 0));

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (delegatedEmpty) return setError('A delegated runner needs at least one workspace.');
    if (reposEmpty) return setError('Pick at least one repository, or clear the machine for all of them.');
    if (rolesEmpty) return setError('Pick at least one role, or open the machine to every role.');
    if (harnessesEmpty) return setError('Pick at least one agent runtime; a machine that runs none still takes work.');
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
        harnesses,
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
                harnessesEmpty ||
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
          description="What this machine reported when the daemon last probed it: what it can do, not what it is allowed to do. The one change you can make here is giving it another model provider."
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
              <span className="flex items-center gap-3">
                <span className="dim text-sm">
                  {health.providers === null
                    ? 'not probed yet'
                    : health.providers.length > 0
                      ? health.providers.join(' · ')
                      : 'none configured'}
                </span>
                {/* Not part of the settings document: it runs against the
                    machine on its own, so it must never submit this form. */}
                <button type="button" className="btn-ghost" onClick={() => setAddingProvider(true)}>
                  Add provider
                </button>
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
          title="Agent runtimes"
          description="What agent work here actually runs on. Only runtimes installed on this machine are listed; a run takes the one marked below, and the rest are kept for when it cannot."
        >
          <HarnessPicker
            runnerId={runner.id}
            local={local}
            selected={harnesses}
            onChange={setHarnesses}
          />
        </Section>

        <Section title="Policy" description="What this machine may be used for.">
          <ListCard subtle>
            <SettingRow
              className="px-4 py-3"
              title="Default answer"
              description={
                policy.mode === 'deny'
                  ? 'Work the list below does not mention is allowed, including tasks later updates add.'
                  : 'Work the list below does not mention is refused, including tasks later updates add.'
              }
            >
              {/* Switching rewrites the list against the registered work, so it
                  must not run before that work has loaded. */}
              <SegmentedControl
                className="w-full sm:w-auto"
                label="Policy mode"
                name="policy-mode"
                value={policy.mode}
                disabled={options.groups.length === 0}
                onChange={(mode) => setPolicy((prev) => convertPolicyMode(prev, options.groups, mode))}
                options={[
                  { value: 'deny', label: 'Everything except', hint: 'New tasks arrive allowed' },
                  { value: 'allow', label: 'Only these', hint: 'New tasks arrive refused' },
                ]}
              />
            </SettingRow>
            <div className="px-4 py-3">
              <TaskPolicyEditor groups={options.groups} policy={policy} onChange={setPolicy} />
            </div>
          </ListCard>
          <p className="dim mt-2 text-xs">
            Switching keeps what this machine may do today; only tasks added later are answered differently.
          </p>
        </Section>

        <Section title="Placement" description="Where this machine participates. Visibility is set by ownership; these only limit what may be placed here.">
          <ListCard subtle>
            <ReachRow
              title="Workspaces"
              legend="Workspace reach"
              name="scope"
              scoped={scope === 'delegated'}
              onScope={(on) => setScope(on ? 'delegated' : 'shared')}
              allLabel="All workspaces"
              someLabel="Selected"
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
              legend="Repository reach"
              name="repo-scope"
              scoped={repoScope === 'selected'}
              onScope={(on) => setRepoScope(on ? 'selected' : 'all')}
              allLabel="All repositories"
              someLabel="Selected"
            >
              <CheckList
                label="Repositories"
                items={options.repos.map((r) => ({ id: r.fullName, label: r.fullName }))}
                selected={repoIds}
                onChange={setRepoIds}
                empty="No repositories connected yet."
                warn={reposEmpty ? 'Pick at least one repository.' : null}
                hint="Work with no repository is placed elsewhere."
              />
            </ReachRow>

            {shared ? (
              <ReachRow
                title="Who may use it"
                description="Automated work has no triggering role, so a restricted machine never receives it."
                legend="Roles"
                name="role-scope"
                scoped={roleScoped}
                onScope={setRoleScoped}
                allLabel="Everyone"
                someLabel="Selected roles"
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

      {addingProvider ? (
        <AddProviderModal
          runner={runner}
          onClose={() => setAddingProvider(false)}
          onAdded={(provider) => {
            setAddingProvider(false);
            setNote(`Added ${provider}`);
          }}
        />
      ) : null}
    </Page>
  );
}

/** Suggestions only: moxxy owns the real list and names it when it refuses one. */
const PROVIDER_SLUGS = [
  'anthropic',
  'claude-code',
  'google',
  'local',
  'openai',
  'openai-codex',
  'xai',
  'zai',
  'zai-plan',
];

/**
 * Providers known to authenticate with a subscription rather than a key. moxxy
 * has no headless path for those, so the form says so instead of pretending the
 * key field will work. Guidance, not a fence: the request still goes through,
 * because moxxy is the authority on what it accepts and this list will age.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['claude-code', 'openai-codex', 'zai-plan']);

/**
 * Give a machine a model provider without opening a shell on it. The key is
 * sent once and lives nowhere afterwards: Companion forwards it to that
 * machine's moxxy and stores nothing, so there is no "edit key" here: adding
 * the same provider again replaces it on the machine.
 */
function AddProviderModal({
  runner,
  onClose,
  onAdded,
}: {
  runner: RunnerRecord;
  onClose: () => void;
  onAdded: (provider: string) => void;
}): JSX.Element {
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = provider.trim().toLowerCase();
  const subscription = SUBSCRIPTION_PROVIDERS.has(slug);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addRunnerProvider(runner.id, {
        provider: slug,
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      onAdded(slug);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add a provider to ${runner.name}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Provider" hint="moxxy's provider name; it rejects one it doesn't know and lists the valid ones.">
          <input
            className="input"
            list="moxxy-provider-slugs"
            required
            autoFocus
            placeholder="anthropic"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <datalist id="moxxy-provider-slugs">
            {PROVIDER_SLUGS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field
          label="API key"
          hint={
            subscription ? (
              <span className="text-amber-600 dark:text-amber-400">
                {slug} signs in with a subscription, not a key. Run{' '}
                <code className="code-inline">moxxy login {slug}</code> on the machine itself.
              </span>
            ) : (
              'Sent straight to this machine’s moxxy and stored only there. Companion never keeps a copy.'
            )
          }
        >
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Field label="Default model" hint="Optional; leave empty to keep the provider's own default.">
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <ErrorBar error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || slug.length === 0}>
            {busy ? 'Adding…' : 'Add provider'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The app's all-or-selected reach control: one segmented choice, then the picker. */
function ReachRow({
  title,
  description,
  legend,
  name,
  scoped,
  onScope,
  allLabel,
  someLabel,
  children,
}: {
  title: string;
  description?: string;
  legend: string;
  name: string;
  scoped: boolean;
  onScope: (scoped: boolean) => void;
  allLabel: string;
  someLabel: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="px-4 py-3">
      <SettingRow title={title} description={description}>
        <SegmentedControl
          className="w-full sm:w-auto"
          label={legend}
          name={name}
          value={scoped ? 'some' : 'all'}
          onChange={(v) => onScope(v === 'some')}
          options={[
            { value: 'all', label: allLabel },
            { value: 'some', label: someLabel },
          ]}
        />
      </SettingRow>
      {scoped ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/**
 * The machine's agent runtimes, offered from what is actually installed on it.
 *
 * Three states settle what a row looks like, and the third one is why detection
 * beats a catalogue: a runtime that is not installed is not here at all, one
 * that is installed but cannot complete a turn is here unticked with the single
 * command that repairs it, and a ready one is just a choice. An empty list is
 * the only case that needs sentences, because a question with no options is not
 * a question.
 */
function HarnessPicker({
  runnerId,
  local,
  selected,
  onChange,
}: {
  runnerId: string;
  local: boolean;
  selected: readonly string[];
  onChange: (next: readonly string[]) => void;
}): JSX.Element {
  const [options, setOptions] = useState<readonly HarnessOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .runnerHarnesses(runnerId)
      .then((r) => alive && setOptions(r.options))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [runnerId]);

  if (!local) {
    return (
      <p className="dim rounded-lg border border-dashed border-zinc-300 p-3 text-xs dark:border-zinc-700">
        A machine reached over the network runs moxxy. The runner agent speaks one runtime, so this is not a choice
        there.
      </p>
    );
  }
  if (failed) return <p className="dim text-xs">Could not read what is installed on this machine.</p>;
  if (options === null) return <p className="dim text-xs">Looking at what is installed…</p>;
  if (options.length === 0) {
    return (
      <div className="banner-warn">
        No agent runtime is installed on this machine, so nothing can run here yet. Install one and reload:{' '}
        <code>npm i -g @moxxy/cli</code>, <code>npm i -g @anthropic-ai/claude-code</code> or{' '}
        <code>npm i -g @openai/codex</code>.
      </div>
    );
  }

  // Chosen once, and no longer on the machine. It cannot be a row (there is
  // nothing to tick) and it cannot be silent either: runs placed here would
  // fail at spawn with nothing on this page saying why.
  const gone = selected.filter((id) => !options.some((o) => o.id === id));

  return (
    <ListCard subtle ariaLabel="Agent runtimes on this machine">
      {gone.length > 0 ? (
        <div className="px-4 py-3">
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Set to {gone.join(', ')}, which is no longer installed here. Reinstall it, or tick another runtime and
            save.
          </span>
        </div>
      ) : null}
      {options.map((option) => (
        <SettingRow
          key={option.id}
          className="px-4 py-3"
          title={
            <span className="flex items-center gap-2">
              {/* Linked for the same reason the CLI's setup list carries the
                  address: this is where a name like Moxxy or Codex is met, and
                  a product nobody can look up is not a choice anyone can make. */}
              {option.homepage ? (
                <a className="linkish" href={option.homepage} target="_blank" rel="noreferrer">
                  {option.label}
                </a>
              ) : (
                option.label
              )}
              {/* Ticking a second runtime beside the first changes nothing, and
                  two ticked boxes would otherwise look the same whichever one
                  work actually runs through. */}
              {option.id === selected[0] ? <span className="chip">runs work here</span> : null}
            </span>
          }
          description={
            option.detail === null ? (
              'Installed and ready.'
            ) : (
              <>
                {option.detail}
                {option.fix ? (
                  <>
                    {' '}
                    Fix it with <code>{option.fix}</code>.
                  </>
                ) : null}
              </>
            )
          }
        >
          <input
            type="checkbox"
            aria-label={`Run agents through ${option.label}`}
            checked={selected.includes(option.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, option.id]
                  : selected.filter((id) => id !== option.id),
              )
            }
          />
        </SettingRow>
      ))}
    </ListCard>
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
  hint,
}: {
  label: string;
  items: readonly { id: string; label: string; note?: string }[];
  selected: readonly string[];
  onChange: (next: readonly string[]) => void;
  empty: string;
  warn: string | null;
  /** What narrowing this list costs; the warning supersedes it. */
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex w-full flex-col gap-1 text-sm">
      <div
        role="group"
        aria-label={label}
        className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 sm:grid-cols-2 dark:border-zinc-800"
      >
        {items.length === 0 ? <span className="dim px-2 py-1.5 sm:col-span-2">{empty}</span> : null}
        {items.map((item) => (
          <label
            key={item.id}
            className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          >
            <input
              type="checkbox"
              className="shrink-0"
              checked={selected.includes(item.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))
              }
            />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.note ? <span className="dim shrink-0 text-xs">{item.note}</span> : null}
          </label>
        ))}
      </div>
      {warn ? (
        <span className="text-xs text-amber-600 dark:text-amber-400">{warn}</span>
      ) : hint ? (
        <span className="dim text-xs">{hint}</span>
      ) : null}
    </div>
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function samePolicy(a: RunnerTaskPolicy, b: RunnerTaskPolicy): boolean {
  return a.mode === b.mode && sameStrings(a.modules, b.modules) && sameStrings(a.tasks, b.tasks);
}
