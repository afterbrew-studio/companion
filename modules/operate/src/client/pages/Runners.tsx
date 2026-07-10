import { useEffect, useRef, useState } from 'react';
import { Modal, Page, PageHeader, Spinner, Switch, Tooltip, timeAgo, useConfirm } from '@companion/ui';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type {
  RunnerCatalog,
  RunnerModelPins,
  RunnerPinnableKind,
  RunnerRecord,
  RunnerScope,
  RunnerStatus,
  UpdateRunnerRequest,
} from '../../contract/index.js';
import { RUNNER_PINNABLE_KINDS } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunners } from '../hooks/useRunners.js';

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
  const { runners, workspaces, error, setError, refresh } = useRunners();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RunnerRecord | null>(null);

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
        {/* Health/test controls live by the title now, not in a footer. */}
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
        <Tooltip content="Test connection">
          <button
            className="dim rounded-md p-1 transition-colors hover:bg-zinc-200 hover:text-zinc-800 disabled:opacity-50 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            aria-label="Test connection"
            disabled={probe === 'busy'}
            onClick={() => void testConnection()}
          >
            <svg viewBox="0 0 16 16" fill="none" className={`size-4 ${probe === 'busy' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden>
              <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M13 2.5V5.5H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
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
        ) : health.providers !== null ? (
          health.providers.length > 0 ? (
            <Tooltip content="model providers configured on this machine — placement matches runs to them">
              <span>{health.providers.join(' · ')}</span>
            </Tooltip>
          ) : (
            <Tooltip content="no model providers configured — agent work is not placed here">
              <span className="text-amber-600 dark:text-amber-500">no providers</span>
            </Tooltip>
          )
        ) : null}
      </div>

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
companion-runner setup    # installs the moxxy CLI if missing, opens the firewall

COMPANION_RUNNER_TOKEN=<pick-a-secret> companion-runner --background`}
          </pre>
          <span className="dim">
            <code className="font-mono">companion-runner doctor</code> reports what a box still needs. Leave{' '}
            <code className="font-mono">COMPANION_RUNNER_TOKEN</code> out and the agent generates one — printed once and
            saved to <code className="font-mono">~/.companion-runner/token</code>. No GitHub setup is needed on the box:
            Companion sends its own GitHub credential with each clone and push.
          </span>
        </li>
        <li>
          Make sure this Companion can reach the box on its port (default{' '}
          <code className="font-mono text-xs">8920</code>) — a private network address or tunnel is fine.{' '}
          <code className="font-mono">companion-runner open-firewall</code> opens the host firewall if{' '}
          <code className="font-mono">setup</code> didn't.
        </li>
        <li>
          Click <span className="font-medium">Add machine</span> and enter the endpoint (
          <code className="font-mono text-xs">&lt;host&gt;:8920</code> — plain http is fine) and the token. Companion
          probes it, and once it's online you can scope it to workspaces and pin repos to it.
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
  // Model pins + the runner's catalog. For a new runner the catalog only exists
  // after it's created (and probed), so the Add flow is create-then-pin: the
  // first submit connects, then the pins section appears for the saved runner.
  const [modelPins, setModelPins] = useState<RunnerModelPins>(runner?.modelPins ?? {});
  const [catalog, setCatalog] = useState<RunnerCatalog | null>(runner?.catalog ?? null);
  const [savedId, setSavedId] = useState<string | null>(runner?.id ?? null);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);

  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;
  const capacity = Number(maxRuns);

  const normalizeEndpoint = (raw: string): string => {
    const trimmed = raw.trim();
    return trimmed && !/^https?:\/\//i.test(trimmed) ? `http://${trimmed}` : trimmed;
  };

  const connectionBody = (): UpdateRunnerRequest => ({
    name: name.trim(),
    scope,
    workspaceIds: scope === 'delegated' ? workspaceIds : [],
    maxRuns: capacity,
    modelPins,
    ...(local ? {} : { endpoint: normalizeEndpoint(endpoint), ...(token.trim() ? { token: token.trim() } : {}) }),
  });

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (delegatedEmpty) {
      setError('A delegated runner needs at least one workspace.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (savedId) {
        // Existing runner (edit, or the second save of a just-added one).
        await api.updateRunner(savedId, connectionBody());
        onDone();
      } else {
        // First save of a new runner: create + probe, then reveal the pins.
        const { runner: made } = await api.createRunner({
          name: name.trim(),
          endpoint: normalizeEndpoint(endpoint),
          token: token.trim(),
          scope,
          workspaceIds: scope === 'delegated' ? workspaceIds : [],
          maxRuns: capacity,
        });
        setSavedId(made.id);
        setCatalog(made.catalog);
        setModelPins(made.modelPins);
        setTestNote(
          made.catalog && made.catalog.providers.some((p) => p.ready)
            ? 'Connected — pin models per action below, or leave them on the runner default.'
            : 'Connected, but no provider with credentials was found on this machine. Configure a provider there, then fetch models.',
        );
        setBusy(false);
      }
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  // Probe the runner and pull its model catalog into the pin dropdowns. Doubles
  // as a reachability check — the note reports what came back (or why nothing did).
  const fetchModels = async (): Promise<void> => {
    if (!savedId) return;
    setTesting(true);
    setTestNote(null);
    setError(null);
    try {
      const result = await api.probeRunner(savedId);
      setCatalog(result.catalog);
      const ready = (result.catalog?.providers ?? []).filter((p) => p.ready);
      const modelCount = new Set(ready.flatMap((p) => p.models.map((m) => m.id))).size;
      setTestNote(
        !result.ok
          ? (result.health.detail ?? 'unreachable')
          : modelCount > 0
            ? `${modelCount} model${modelCount === 1 ? '' : 's'} from ${ready.length} provider${ready.length === 1 ? '' : 's'}.`
            : 'Reachable, but no provider with credentials was found on this machine.',
      );
    } catch (err) {
      setTestNote(String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal wide={!!savedId} title={runner ? `Edit ${runner.name}` : 'Add machine'} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className={savedId ? 'grid gap-x-6 gap-y-3 md:grid-cols-2' : 'flex flex-col gap-3'}>
          <div className="flex flex-col gap-3">
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
              <span className="dim">Endpoint — companion-runner agent address</span>
              <input
                className="input"
                type="text"
                required
                placeholder="192.168.1.42:8920"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
              <span className="dim text-xs">
                Plain <code className="font-mono">host:port</code> or <code className="font-mono">ip:port</code> works —
                http is assumed unless you write <code className="font-mono">https://</code>.
              </span>
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
          </div>

        {/* Model pins fill the second column once the runner exists and is probed. */}
        {savedId ? (
          <fieldset className="flex flex-col gap-2 border-t border-zinc-200 pt-3 md:border-t-0 md:border-l md:pt-0 md:pl-6 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium">Model pins</legend>
              <button type="button" className="btn-ghost text-xs" disabled={testing} onClick={() => void fetchModels()}>
                {testing ? 'Fetching…' : 'Fetch models'}
              </button>
            </div>
            <p className="dim text-xs">
              Bind each action to a model this machine can serve. Unpinned actions ride its own default.
            </p>
            {testNote ? <p className="dim text-xs">{testNote}</p> : null}
            <ModelPinsEditor catalog={catalog} pins={modelPins} onChange={setModelPins} />
          </fieldset>
        ) : null}
        </div>

        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {savedId && !runner ? 'Done' : 'Cancel'}
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
              (!savedId && !token.trim())
            }
          >
            {busy
              ? savedId
                ? 'Saving…'
                : 'Connecting…'
              : savedId
                ? 'Save'
                : 'Connect & continue'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const PIN_LABELS: Record<RunnerPinnableKind, string> = {
  triage: 'Issue triage',
  analysis: 'Reviews & analyses',
  fix: 'Fix runs',
  implement: 'Implement runs',
  report: 'Reports',
  interactive: 'Interactive chats',
  assistant: 'AI Help',
};

/** Per-action model dropdowns, options drawn from the runner's ready models. */
function ModelPinsEditor({
  catalog,
  pins,
  onChange,
}: {
  catalog: RunnerCatalog | null;
  pins: RunnerModelPins;
  onChange: (next: RunnerModelPins) => void;
}): JSX.Element {
  // Ready models across the runner's providers, de-duplicated by id.
  const models = Array.from(
    new Map(
      (catalog?.providers ?? [])
        .filter((p) => p.ready)
        .flatMap((p) => p.models.map((m) => [m.id, m] as const)),
    ).values(),
  );

  if (models.length === 0) {
    return (
      <p className="dim rounded-lg border border-dashed border-zinc-300 p-3 text-xs dark:border-zinc-700">
        No ready models on this machine yet — configure a provider there and re-test to pin models.
      </p>
    );
  }

  const set = (kind: RunnerPinnableKind, model: string): void => {
    const next = { ...pins };
    if (model) next[kind] = model;
    else delete next[kind];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {RUNNER_PINNABLE_KINDS.map((kind) => (
        <label key={kind} className="flex items-center justify-between gap-2 text-xs">
          <span className="dim min-w-0 flex-1 truncate">{PIN_LABELS[kind]}</span>
          <select
            className="input w-40 shrink-0 py-1.5 text-sm"
            value={pins[kind] ?? ''}
            onChange={(e) => set(kind, e.target.value)}
          >
            <option value="">Runner default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
