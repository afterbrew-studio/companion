import { useRef, useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  InlineLoading,
  Modal,
  Page,
  PageHeader,
  StatusDot,
  Switch,
  Tooltip,
  timeAgo,
  useConfirm,
  type StatusTone,
} from '@moxxy/companion-ui';
import { useAuth } from '@companion/module-core/client';
import type { RunnerRecord, RunnerStatus, RunnerTaskPolicy, RunTaskDescriptor } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunners } from '../hooks/useRunners.js';

export const DOT_TONE: Record<RunnerStatus, StatusTone> = {
  online: 'green',
  degraded: 'amber',
  offline: 'red',
  unknown: 'zinc',
};

/**
 * Execution machines. Everyone sees the shared pool plus only their own
 * private machines; admins can manage the shared pool without gaining sight
 * of other users' private machines. Health is polled by the daemon and pushed
 * over WS.
 */
export function RunnersPage(): React.JSX.Element {
  const { runners, tasks, error, setError, refresh } = useRunners();
  const { user, can } = useAuth();
  const admin = can('runners:manage');
  const [creating, setCreating] = useState(false);
  // The seeded "This machine" row keeps the list from ever being literally
  // empty, so "nothing attached yet" means no listed machine can take agent
  // work: the same enabled + agent + ready-runtime test /api/status applies.
  const noneReady =
    runners !== null &&
    runners.every(
      (r) => !r.enabled || r.health.agentOutdated === true || r.health.runtimes[0]?.state !== 'ready',
    );

  return (
    <Page>
      <PageHeader
        title="Runners"
        subtitle="Shared machines available to everyone, plus private machines only you can see and use"
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            Add machine
          </button>
        }
      />
      <ErrorBar error={error} />

      <AttachGuide open={noneReady} />

      {runners === null ? (
        <InlineLoading label="Loading runners…" className="py-8" />
      ) : runners.length === 0 ? (
        <EmptyState
          title="No machines of your own yet"
          hint="Attach a machine you control — a desktop at home, a spare laptop, a VM — and every agent run you trigger is placed on it, using the model providers (and subscriptions) configured there instead of the shared pool."
          action={
            <button className="btn" onClick={() => setCreating(true)}>
              Add your machine
            </button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {runners.map((runner) => (
            <RunnerCard
              key={runner.id}
              runner={runner}
              tasks={tasks}
              admin={admin}
              me={user?.username ?? null}
              onEdit={() => (location.hash = `#/runners/${runner.id}`)}
              onChange={refresh}
              onError={setError}
            />
          ))}
        </div>
      )}

      {creating ? (
        <RunnerModal
          admin={admin}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            location.hash = `#/runners/${id}`;
          }}
        />
      ) : null}
    </Page>
  );
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function RunnerCard({
  runner,
  tasks,
  admin,
  me,
  onEdit,
  onChange,
  onError,
}: {
  runner: RunnerRecord;
  tasks: readonly RunTaskDescriptor[];
  admin: boolean;
  me: string | null;
  onEdit: () => void;
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<'busy' | { ok: boolean; note: string } | null>(null);
  const probeTimer = useRef<number | undefined>(undefined);
  const { confirmDanger, confirmElement } = useConfirm();
  const local = runner.kind === 'local';
  const manageable = runner.ownerId === me || (runner.ownerId === null && admin);
  const { health } = runner;
  const agentOutdated = health.agentOutdated === true;
  const unavailableRuntimes = health.runtimes.filter((runtime) => runtime.state !== 'ready');
  const providerBacked = runner.harnesses.some((runtime) => runtime.capabilities.models === 'providers');

  const setEnabled = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.updateRunner(runner.id, { enabled });
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (): Promise<void> => {
    window.clearTimeout(probeTimer.current);
    setProbe('busy');
    try {
      const result = await api.probeRunner(runner.id);
      const ready = result.health.runtimes.filter((runtime) => runtime.state === 'ready').map((runtime) => runtime.label);
      setProbe({
        ok: result.ok,
        note: result.ok ? `reachable${ready.length > 0 ? ` · ${ready.join(' · ')}` : ''}` : (result.health.detail ?? 'unreachable'),
      });
    } catch (err) {
      setProbe({ ok: false, note: String(err) });
    }
    // Health changes land via the runners.changed broadcast; only the
    // transient note needs local cleanup.
    probeTimer.current = window.setTimeout(() => setProbe(null), 6000);
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete ${runner.name}`,
      message:
        'The machine is detached — no new agent work is placed on it. Repos pinned to it fall back to automatic placement.',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteRunner(runner.id);
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const scopeNote =
    runner.scope === 'shared'
      ? 'all workspaces'
      : `${runner.workspaceIds.length} ${runner.workspaceIds.length === 1 ? 'workspace' : 'workspaces'}`;
  const repoNote =
    runner.repoScope === 'selected'
      ? `${runner.repoIds.length} ${runner.repoIds.length === 1 ? 'repo' : 'repos'}`
      : null;
  // A daemon still serving the previous dist during a restart omits the policy
  // fields; the card must not blank out for the seconds that lasts.
  const roleNote = runner.allowedRoles?.length ? runner.allowedRoles.join(' · ') : null;
  const taskNote = runner.taskPolicy ? policySummary(runner.taskPolicy, tasks) : null;

  return (
    <article className={`card ${runner.enabled ? '' : 'opacity-70'}`} aria-label={runner.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip content={health.detail ?? health.status}>
          <StatusDot
            tone={DOT_TONE[health.status]}
            size="lg"
            pulse={health.liveRuns > 0}
            label={health.detail ?? health.status}
          />
        </Tooltip>
        <span className="text-sm font-medium">{runner.name}</span>
        <span className="chip">{runner.kind}</span>
        {local ? <span className="dim">this machine</span> : null}
        <Tooltip
          content={
            runner.ownerId === null
              ? 'shared — any eligible run can land here; admins manage its settings'
              : 'private — only runs you trigger can land here'
          }
        >
          <span className="chip">{runner.ownerId === null ? 'shared' : 'private'}</span>
        </Tooltip>
        <span className="flex-1" />
        {/* Health/test controls live by the title now, not in a footer. */}
        {probe !== null && probe !== 'busy' ? (
          <span
            role="status"
            className={`text-xs ${probe.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {probe.ok ? '✓' : '✕'} {probe.note}
          </span>
        ) : null}
        {!manageable ? (
          <Tooltip content="Shared runner settings are managed by admins">
            <Switch label={`${runner.name} enabled`} checked={runner.enabled} disabled onChange={() => undefined} />
          </Tooltip>
        ) : local ? (
          <Tooltip content="the local runner is always on">
            <Switch label={`${runner.name} enabled`} checked disabled onChange={() => undefined} />
          </Tooltip>
        ) : (
          <Switch
            label={`${runner.name} enabled`}
            checked={runner.enabled}
            disabled={busy}
            onChange={(v) => void setEnabled(v)}
          />
        )}
        {manageable ? (
          <IconButton label="Test connection" disabled={probe === 'busy'} onClick={() => void testConnection()}>
            <svg viewBox="0 0 16 16" fill="none" className={`size-4 ${probe === 'busy' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden>
              <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M13 2.5V5.5H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        ) : null}
      </div>

      <div className="dim mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[18px]">
        <span>{scopeNote}</span>
        {repoNote ? (
          <Tooltip content={runner.repoIds.join('\n')}>
            <span>{repoNote}</span>
          </Tooltip>
        ) : null}
        {roleNote ? (
          <Tooltip content="only these roles may place work here">
            <span>{roleNote}</span>
          </Tooltip>
        ) : null}
        <span className="tabular-nums">
          {health.liveRuns} / {runner.maxRuns} running
        </span>
        {taskNote ? (
          <Tooltip content="task policy — edit the machine to change what it may be used for">
            <span>{taskNote}</span>
          </Tooltip>
        ) : null}
        {health.runtimes.map((runtime) => (
          <Tooltip key={runtime.id} content={runtime.detail ?? `${runtime.label} is ready`}>
            <span className={runtime.state === 'ready' ? '' : 'text-amber-600 dark:text-amber-400'}>
              {runtime.label}
              {runtime.version ? ` ${runtime.version}` : ''}
            </span>
          </Tooltip>
        ))}
        {!local && runner.endpoint ? <span>{endpointHost(runner.endpoint)}</span> : null}
        {health.status === 'offline' ? (
          <span>{health.lastSeenAt ? `last seen ${timeAgo(health.lastSeenAt)}` : 'never seen'}</span>
        ) : providerBacked && runner.catalog !== null ? (
          runner.catalog.providers.some((provider) => provider.ready) ? (
            <Tooltip content="model providers configured on this machine — placement matches runs to them">
              <span>
                {runner.catalog.providers
                  .filter((provider) => provider.ready)
                  .map((provider) => provider.name)
                  .join(' · ')}
              </span>
            </Tooltip>
          ) : (
            <Tooltip content="no model providers configured — agent work is not placed here">
              <span className="text-amber-600 dark:text-amber-400">no providers</span>
            </Tooltip>
          )
        ) : null}
      </div>

      {agentOutdated ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-[13px] leading-relaxed">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            The runner agent on this machine is outdated ({health.detail}).
          </p>
          <p className="dim mt-1">Update it on the machine itself — an old agent can't be updated remotely:</p>
          <pre className="mono-pane mt-1.5">
{`npm i -g @moxxy/companion-runner
companion-runner stop && companion-runner --background`}
          </pre>
        </div>
      ) : unavailableRuntimes.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-[13px]">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {unavailableRuntimes.map((runtime) => runtime.label).join(', ')} needs attention on this machine.
          </p>
          <p className="dim mt-1">
            {unavailableRuntimes.map((runtime) => runtime.detail).filter(Boolean).join(' · ') ||
              'Open the machine settings to choose another detected runtime.'}
          </p>
        </div>
      ) : null}

      {manageable ? (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
          <button className="btn-ghost" onClick={onEdit}>
            Edit
          </button>
          {!local ? (
            <>
              <span className="action-sep" aria-hidden />
              <button className="btn-danger-ghost" disabled={busy} onClick={() => void remove()}>
                Delete
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {confirmElement}
    </article>
  );
}

/** Collapsible "how to attach a machine" primer above the runner list. Starts
 *  open while no machine is ready (the guide IS the next step in that state);
 *  React only re-syncs `open` when the value changes, so manual toggling wins. */
function AttachGuide({ open }: { open: boolean }): React.JSX.Element {
  return (
    <details className="banner-info mb-4 block" open={open}>
      <summary className="cursor-pointer list-none font-medium">
        How to attach a machine
        <span className="dim ml-1.5 font-normal">— three steps</span>
      </summary>
      <ol className="mt-2.5 ml-4 list-decimal space-y-2 text-[13px] leading-relaxed">
        <li>
          On the machine you want to add, install the runner agent, let it check its runtime and network prerequisites,
          then start it:
          <pre className="mono-pane mt-1.5">
{`npm i -g @moxxy/companion-runner
companion-runner setup    # checks the runtime and opens the firewall

COMPANION_RUNNER_TOKEN=<pick-a-secret> companion-runner --background`}
          </pre>
          <span className="dim">
            <code className="code-inline">companion-runner doctor</code> reports what a box still needs. Leave{' '}
            <code className="code-inline">COMPANION_RUNNER_TOKEN</code> out and the agent generates one — printed once and
            saved to <code className="code-inline">~/.companion-runner/token</code>. No GitHub setup is needed on the box:
            Companion sends its own GitHub credential with each clone and push. To survive reboots and crashes, register
            it as a service instead of <code className="code-inline">--background</code>:{' '}
            <code className="code-inline">companion-runner autostart</code>.
          </span>
        </li>
        <li>
          Make sure this Companion can reach the box on its port (default{' '}
          <code className="code-inline">8920</code>) — a private network address or tunnel is fine.{' '}
          <code className="code-inline">companion-runner open-firewall</code> opens the host firewall if{' '}
          <code className="code-inline">setup</code> didn't.
        </li>
        <li>
          Click <span className="font-medium">Add machine</span> and enter the endpoint (
          <code className="code-inline">&lt;host&gt;:8920</code> — plain http is fine) and the token. Companion
          probes it, and once it's online you can scope it to workspaces and pin repos to it.
        </li>
      </ol>
      <div className="mt-3 border-t border-zinc-200 pt-2.5 text-[13px] leading-relaxed dark:border-zinc-800">
        <span className="font-medium">Keeping a machine up to date</span>
        <p className="dim mt-1">
          When a card shows a <span className="text-amber-600 dark:text-amber-400">version mismatch</span>, the{' '}
          <code className="code-inline">companion-runner</code> agent itself is outdated — update it on the machine:
        </p>
        <pre className="mono-pane mt-1.5">
{`npm i -g @moxxy/companion-runner
companion-runner stop && companion-runner --background`}
        </pre>
        <p className="dim mt-1.5">
          Runtime installation, sign-in, and upgrades stay on that machine and use the runtime's own tooling. Companion
          detects the resulting capability on the next health poll; it does not install or upgrade runtimes remotely.
        </p>
      </div>
    </details>
  );
}

/** Where the runner token comes from — shown under the token field. */
export function TokenHelp(): React.JSX.Element {
  return (
    <details className="mt-1">
      <summary className="dim cursor-pointer text-xs hover:text-zinc-700 dark:hover:text-zinc-300">
        Where do I find the token?
      </summary>
      <div className="dim mt-1.5 rounded-lg border border-zinc-200 p-2.5 text-xs leading-relaxed dark:border-zinc-800">
        The token is set on the machine running the <code className="code-inline">companion-runner</code> agent. It comes
        from one of, in order:
        <ol className="mt-1.5 ml-4 list-decimal space-y-1">
          <li>
            the <code className="code-inline">COMPANION_RUNNER_TOKEN</code> you started the agent with — use that exact
            value;
          </li>
          <li>
            if you didn't set one, the agent generated it and saved it to{' '}
            <code className="code-inline">~/.companion-runner/token</code> (under{' '}
            <code className="code-inline">COMPANION_RUNNER_HOME</code> if you changed it). Read it on that box with:
            <pre className="mono-pane mt-1">cat ~/.companion-runner/token</pre>
          </li>
          <li>
            it's also printed once in the agent's startup log (
            <code className="code-inline">COMPANION_RUNNER_TOKEN not set — generated one…</code>).
          </li>
        </ol>
        Paste that value here; it's stored write-only and never shown again.
      </div>
    </details>
  );
}

/** Hoisted so the settings page normalizes endpoints identically. */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  return trimmed && !/^https?:\/\//i.test(trimmed) ? `http://${trimmed}` : trimmed;
}

/**
 * Add-machine flow: just the connection handshake (name, endpoint, token,
 * ownership). Everything else (placement, capacity, tasks) lives on the
 * machine's own settings page, opened right after it connects.
 */
function RunnerModal({
  admin,
  onClose,
  onCreated,
}: {
  admin: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  // Ownership is set at creation and immutable after: admins choose shared vs
  // private; everyone else's machine is private by definition.
  const [shared, setShared] = useState(admin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { runner: made } = await api.createRunner({
        name: name.trim(),
        endpoint: normalizeEndpoint(endpoint),
        token: token.trim(),
        shared: admin && shared,
      });
      onCreated(made.id);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Add machine" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Name">
          <input
            className="input"
            required
            minLength={2}
            maxLength={80}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
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
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <TokenHelp />
        </Field>
        {admin ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="dim mb-1 text-sm">Ownership</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="ownership" checked={shared} onChange={() => setShared(true)} />
              Shared
              <span className="dim text-xs">— part of the instance pool, any eligible run lands here</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="ownership" checked={!shared} onChange={() => setShared(false)} />
              Private
              <span className="dim text-xs">— only runs you trigger land here, on this machine's subscription</span>
            </label>
          </fieldset>
        ) : (
          <p className="dim text-xs">
            This machine is private: only agent runs you trigger are placed on it, using the model providers configured
            there — your subscription, your keys.
          </p>
        )}
        <p className="dim text-xs">
          Once connected you land on the machine's page to scope it and pick the tasks it takes.
        </p>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="submit"
            disabled={busy || name.trim().length < 2 || !endpoint.trim() || !token.trim()}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/**
 * The machine's task policy as one line on its card: what it is limited to, or
 * what it refuses. A module entry has no descriptor to name it, so it reads as
 * "all <module>" — which is what it means, including work added later.
 */
function policySummary(policy: RunnerTaskPolicy, tasks: readonly RunTaskDescriptor[]): string | null {
  const named = [
    ...policy.modules.map((id) => `all ${id}`),
    // A task id whose module is disabled has no descriptor — show it raw.
    ...policy.tasks.map((id) => (tasks.find((t) => t.id === id)?.label ?? id).toLowerCase()),
  ];
  if (policy.mode === 'deny') return named.length > 0 ? `skips ${named.join(' · ')}` : null;
  return named.length > 0 ? `only ${named.join(' · ')}` : 'takes nothing';
}
