import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RunnerRecord,
  RunnerScope,
  RunnerStatus,
  UpdateRunnerRequest,
  WorkspaceRecord,
} from '@companion/contract';
import { api } from '../lib/api.js';
import { useLive } from '../lib/live.js';
import { Modal, Page, PageHeader, Spinner, Switch, Tooltip, timeAgo, useConfirm } from '../components/ui.js';

const DOT_COLOR: Record<RunnerStatus, string> = {
  online: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  offline: 'bg-red-500',
  unknown: 'bg-zinc-400 dark:bg-zinc-500',
};

/**
 * Execution machines. The built-in local runner (companiond's own box) is
 * always present and undeletable; remote runners are attached by endpoint +
 * bearer token. Health is polled by the daemon and pushed over WS.
 */
export function RunnersPage(): JSX.Element {
  const [runners, setRunners] = useState<RunnerRecord[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RunnerRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { runners } = await api.listRunners();
      setRunners(runners);
      setError(null);
    } catch (err) {
      setError(String(err));
      setRunners((prev) => prev ?? []);
    }
  }, []);

  useLive(refresh, (msg) => msg.t === 'runners.changed');

  useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => setWorkspaces([]));
  }, []);

  return (
    <Page>
      <PageHeader
        title="Runners"
        subtitle="Machines that execute agent work — this one plus any you attach"
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            Add machine
          </button>
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      <AttachGuide />

      {runners === null ? (
        <div className="dim flex items-center gap-2.5 py-8 text-sm">
          <Spinner /> Loading runners…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {runners.map((runner) => (
            <RunnerCard
              key={runner.id}
              runner={runner}
              onEdit={() => setEditing(runner)}
              onChange={refresh}
              onError={setError}
            />
          ))}
        </div>
      )}

      {creating ? (
        <RunnerModal
          workspaces={workspaces}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void refresh();
          }}
        />
      ) : null}
      {editing ? (
        <RunnerModal
          runner={editing}
          workspaces={workspaces}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void refresh();
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
  onEdit,
  onChange,
  onError,
}: {
  runner: RunnerRecord;
  onEdit: () => void;
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<'busy' | { ok: boolean; note: string } | null>(null);
  const probeTimer = useRef<number | undefined>(undefined);
  const { confirmDanger, confirmElement } = useConfirm();
  const local = runner.kind === 'local';
  const { health } = runner;

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
      setProbe({
        ok: result.ok,
        note: result.ok
          ? `reachable — moxxy ${result.health.moxxyVersion ?? 'unknown'}`
          : (result.health.detail ?? 'unreachable'),
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
      ? 'shared'
      : `delegated to ${runner.workspaceIds.length} ${runner.workspaceIds.length === 1 ? 'workspace' : 'workspaces'}`;

  return (
    <article className={`card ${runner.enabled ? '' : 'opacity-70'}`} aria-label={runner.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip content={health.detail ?? health.status}>
          <span
            className={`size-2.5 shrink-0 rounded-full ${DOT_COLOR[health.status]} ${
              health.liveRuns > 0 ? 'animate-pulse motion-reduce:animate-none' : ''
            }`}
            role="img"
            aria-label={`Health: ${health.detail ?? health.status}`}
          />
        </Tooltip>
        <span className="text-sm font-medium">{runner.name}</span>
        <span className="chip">{runner.kind}</span>
        {local ? <span className="dim">this machine</span> : null}
        <span className="flex-1" />
        {!runner.enabled ? <span className="badge">disabled</span> : null}
      </div>

      <div className="dim mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[18px]">
        <span>{scopeNote}</span>
        <span className="tabular-nums">
          {health.liveRuns} / {runner.maxRuns} running
        </span>
        {health.moxxyVersion ? <span>moxxy {health.moxxyVersion}</span> : null}
        {!local && runner.endpoint ? <span>{endpointHost(runner.endpoint)}</span> : null}
        {health.status === 'offline' ? (
          <span>{health.lastSeenAt ? `last seen ${timeAgo(health.lastSeenAt)}` : 'never seen'}</span>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        {probe !== null && probe !== 'busy' ? (
          <span
            role="status"
            className={`text-xs ${probe.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {probe.ok ? '✓' : '✕'} {probe.note}
          </span>
        ) : null}
        {local ? (
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
        {!local ? (
          <button className="btn-ghost" disabled={probe === 'busy'} onClick={() => void testConnection()}>
            {probe === 'busy' ? 'Testing…' : 'Test connection'}
          </button>
        ) : null}
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
      {confirmElement}
    </article>
  );
}

/** Collapsible "how to attach a machine" primer above the runner list. */
function AttachGuide(): JSX.Element {
  return (
    <details className="banner-info mb-4 block">
      <summary className="cursor-pointer list-none font-medium">
        How to attach a machine
        <span className="dim ml-1.5 font-normal">— three steps</span>
      </summary>
      <ol className="mt-2.5 ml-4 list-decimal space-y-2 text-[13px] leading-relaxed">
        <li>
          On the machine you want to add, install the agent and let it check/repair prerequisites (Node, the moxxy CLI,
          providers), then start it:
          <pre className="mono-pane mt-1.5">
{`npm i -g @moxxy/companion-runner
companion-runner setup    # installs the moxxy CLI if missing

COMPANION_RUNNER_TOKEN=<pick-a-secret> \\
COMPANION_RUNNER_GITHUB_TOKEN=<github-pat> \\
companion-runner`}
          </pre>
          <span className="dim">
            <code className="font-mono">companion-runner doctor</code> reports what a box still needs. Leave{' '}
            <code className="font-mono">COMPANION_RUNNER_TOKEN</code> out and the agent generates one — printed once and
            saved to <code className="font-mono">~/.companion-runner/token</code>.
          </span>
        </li>
        <li>
          Make sure this Companion can reach the box on its port (default{' '}
          <code className="font-mono text-xs">8920</code>) — a private network address or tunnel is fine.
        </li>
        <li>
          Click <span className="font-medium">Add machine</span> and enter the endpoint (
          <code className="font-mono text-xs">http://&lt;host&gt;:8920</code>) and the token. Companion probes it, and
          once it's online you can scope it to workspaces and pin repos to it.
        </li>
      </ol>
    </details>
  );
}

/** Where the runner token comes from — shown under the token field. */
function TokenHelp(): JSX.Element {
  return (
    <details className="mt-1">
      <summary className="dim cursor-pointer text-xs hover:text-zinc-700 dark:hover:text-zinc-300">
        Where do I find the token?
      </summary>
      <div className="dim mt-1.5 rounded-lg border border-zinc-200 p-2.5 text-xs leading-relaxed dark:border-zinc-800">
        The token is set on the machine running the <code className="font-mono">companion-runner</code> agent. It comes
        from one of, in order:
        <ol className="mt-1.5 ml-4 list-decimal space-y-1">
          <li>
            the <code className="font-mono">COMPANION_RUNNER_TOKEN</code> you started the agent with — use that exact
            value;
          </li>
          <li>
            if you didn't set one, the agent generated it and saved it to{' '}
            <code className="font-mono">~/.companion-runner/token</code> (under{' '}
            <code className="font-mono">COMPANION_RUNNER_HOME</code> if you changed it). Read it on that box with:
            <pre className="mono-pane mt-1">cat ~/.companion-runner/token</pre>
          </li>
          <li>
            it's also printed once in the agent's startup log (
            <code className="font-mono">COMPANION_RUNNER_TOKEN not set — generated one…</code>).
          </li>
        </ol>
        Paste that value here; it's stored write-only and never shown again.
      </div>
    </details>
  );
}

/** Create (no `runner`) or edit. The local runner hides endpoint + token. */
function RunnerModal({
  runner,
  workspaces,
  onClose,
  onDone,
}: {
  runner?: RunnerRecord;
  workspaces: readonly WorkspaceRecord[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const local = runner?.kind === 'local';
  const [name, setName] = useState(runner?.name ?? '');
  const [endpoint, setEndpoint] = useState(runner?.endpoint ?? '');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState<RunnerScope>(runner?.scope ?? 'shared');
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>(runner?.workspaceIds ?? []);
  const [maxRuns, setMaxRuns] = useState(String(runner?.maxRuns ?? 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;
  const capacity = Number(maxRuns);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (delegatedEmpty) {
      setError('A delegated runner needs at least one workspace.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (runner) {
        const body: UpdateRunnerRequest = {
          name: name.trim(),
          scope,
          workspaceIds: scope === 'delegated' ? workspaceIds : [],
          maxRuns: capacity,
          ...(local ? {} : { endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) }),
        };
        await api.updateRunner(runner.id, body);
      } else {
        await api.createRunner({
          name: name.trim(),
          endpoint: endpoint.trim(),
          token: token.trim(),
          scope,
          workspaceIds: scope === 'delegated' ? workspaceIds : [],
          maxRuns: capacity,
        });
      }
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={runner ? `Edit ${runner.name}` : 'Add machine'} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Name</span>
          <input
            className="input"
            required
            minLength={2}
            maxLength={80}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {local ? null : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="dim">Endpoint — companion-runner agent URL</span>
              <input
                className="input"
                type="url"
                required
                placeholder="https://box.internal:8920"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="dim">Bearer token</span>
              <input
                className="input"
                type="password"
                required={!runner}
                placeholder={runner?.hasToken ? 'leave blank to keep current' : undefined}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <TokenHelp />
            </label>
          </>
        )}

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
              </label>
            ))}
          </fieldset>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Max concurrent runs</span>
          <input
            className="input w-28"
            type="number"
            min={1}
            max={99}
            required
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
          />
        </label>

        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="submit"
            disabled={
              busy ||
              name.trim().length < 2 ||
              delegatedEmpty ||
              !(capacity >= 1) ||
              (!local && !endpoint.trim()) ||
              (!runner && !token.trim())
            }
          >
            {busy ? (runner ? 'Saving…' : 'Adding…') : runner ? 'Save' : 'Add machine'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
