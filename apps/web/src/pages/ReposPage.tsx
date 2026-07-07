import { useCallback, useEffect, useState } from 'react';
import type { GitHubAccountRecord, RepoRecord, WorkspaceRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { Page, EmptyState, Modal, PageHeader, Spinner, timeAgo, useConfirm } from '../components/ui.js';

/**
 * Repository management, scoped to the active workspace. Repos move between
 * workspaces via the per-row selector; the workspace itself (rename/delete)
 * is managed here too.
 */
export function ReposPage(): JSX.Element {
  const { can } = useAuth();
  const { workspaces, current, setCurrent, refresh: refreshWorkspaces } = useWorkspace();
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [accounts, setAccounts] = useState<GitHubAccountRecord[]>([]);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const { repos } = await api.workspaceRepos(current.id);
      setRepos(repos);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useEffect(() => {
    void refresh();
    api
      .listGithubAccounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
    return onServerMessage((msg) => {
      if (msg.t === 'repos.changed' || msg.t === 'workspaces.changed') void refresh();
    });
  }, [refresh]);

  if (!current) {
    return (
      <Page>
        <EmptyState title="No workspace yet" hint="Create a workspace from the sidebar switcher first." />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Repositories"
        subtitle={`${current.name} — connected GitHub repositories in this workspace`}
        actions={
          <>
            {can('workspaces:manage') ? (
              <button className="btn-ghost" onClick={() => setManaging(true)}>
                Workspace settings
              </button>
            ) : null}
            <button className="btn" onClick={() => setAdding(true)}>
              Connect repo
            </button>
          </>
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      {repos.length > 0 ? (
        <div className="flex flex-col gap-3">
          {repos.map((repo) => (
            <RepoCard key={repo.fullName} repo={repo} workspaces={workspaces} accounts={accounts} onChange={refresh} onError={setError} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No repositories in this workspace"
          hint="Connect a GitHub repository to start syncing issues and pull requests."
          action={
            <button className="btn" onClick={() => setAdding(true)}>
              Connect the first repo
            </button>
          }
        />
      )}

      {adding ? (
        <AddRepoModal
          workspace={current}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void refresh();
          }}
        />
      ) : null}
      {managing ? (
        <WorkspaceSettingsModal
          workspace={current}
          canDelete={workspaces.length > 1}
          repoCount={repos.length}
          onClose={() => setManaging(false)}
          onChanged={() => void refreshWorkspaces()}
          onDeleted={() => {
            setManaging(false);
            const next = workspaces.find((w) => w.id !== current.id);
            if (next) setCurrent(next.id);
            void refreshWorkspaces();
          }}
        />
      ) : null}
    </Page>
  );
}

function RepoCard({
  repo,
  workspaces,
  accounts,
  onChange,
  onError,
}: {
  repo: RepoRecord;
  workspaces: readonly WorkspaceRecord[];
  accounts: readonly GitHubAccountRecord[];
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();

  const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const automations: ReadonlyArray<{ label: string; on: boolean }> = [
    { label: 'auto-triage', on: repo.autoTriage },
    { label: 'PR gate', on: repo.prGateEnabled },
    { label: 'digest', on: repo.digestEnabled },
    { label: 'stale sweep', on: repo.staleSweepEnabled },
    { label: 'webhook', on: repo.webhookConfigured },
  ];

  return (
    <article className="card" aria-label={repo.fullName}>
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="font-medium hover:underline"
          href={`https://github.com/${repo.fullName}`}
          target="_blank"
          rel="noreferrer"
        >
          {repo.fullName}
        </a>
        <span className="badge">{repo.private ? 'private' : 'public'}</span>
        <span className="flex-1" />
        <span className="dim">{repo.lastSyncAt ? `synced ${timeAgo(repo.lastSyncAt)}` : 'never synced'}</span>
      </div>

      {!repo.cloneReady ? (
        <div className="banner-info mb-0">
          <Spinner />
          <span>
            Cloning the repository — agents can start working once the local clone is ready. This usually takes under
            a minute.
          </span>
        </div>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="dim">Open issues</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{repo.openIssues}</dd>
        </div>
        <div>
          <dt className="dim">Default branch</dt>
          <dd className="mt-0.5 font-mono text-xs font-medium">{repo.defaultBranch || '—'}</dd>
        </div>
        <div>
          <dt className="dim">Local clone</dt>
          <dd className="mt-0.5 font-medium">{repo.cloneReady ? 'ready' : 'cloning…'}</dd>
        </div>
        <div>
          <dt className="dim">Owner</dt>
          <dd className="mt-0.5 font-medium">{repo.owner}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Automations">
        {automations.map((a) => (
          <span key={a.label} className={a.on ? 'badge-ok normal-case' : 'badge normal-case opacity-70'}>
            {a.on ? '✓' : '○'} {a.label}
          </span>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => api.syncRepo(repo.fullName))()}>
          {busy ? 'Working…' : 'Sync now'}
        </button>
        <button className="btn-ghost" disabled={busy || workspaces.length < 2} title={workspaces.length < 2 ? 'Create another workspace to transfer' : undefined} onClick={() => setTransferring(true)}>
          Transfer…
        </button>
        {accounts.length > 1 ? (
          <label className="dim flex items-center gap-1.5 text-xs">
            posts as
            <select
              className="input py-1.5"
              value={repo.githubAccountId ?? ''}
              disabled={busy}
              aria-label={`GitHub account posting for ${repo.fullName}`}
              title="Reviews, labels, and comments on this repo post as this account"
              onChange={(e) => void act(() => api.setRepoGithubAccount(repo.fullName, e.target.value || null))()}
            >
              <option value="">auto (bindings)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="action-sep" aria-hidden />
        <button
          className="btn-danger-ghost"
          disabled={busy}
          onClick={() =>
            void (async () => {
              const ok = await confirmDanger({
                title: `Disconnect ${repo.fullName}`,
                message: 'Synced issues, PRs, and the local clone are removed from Companion. The GitHub repository itself is untouched.',
                confirmLabel: 'Disconnect',
              });
              if (ok) await act(() => api.removeRepo(repo.fullName))();
            })()
          }
        >
          Remove
        </button>
      </div>
      {confirmElement}

      {transferring ? (
        <TransferRepoModal
          repo={repo}
          workspaces={workspaces}
          onClose={() => setTransferring(false)}
          onDone={() => {
            setTransferring(false);
            void onChange();
          }}
          onError={onError}
        />
      ) : null}
    </article>
  );
}

function TransferRepoModal({
  repo,
  workspaces,
  onClose,
  onDone,
  onError,
}: {
  repo: RepoRecord;
  workspaces: readonly WorkspaceRecord[];
  onClose: () => void;
  onDone: () => void;
  onError: (e: string) => void;
}): JSX.Element {
  const targets = workspaces.filter((w) => w.id !== repo.workspaceId);
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.moveRepo(repo.fullName, target);
      onDone();
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Transfer ${repo.fullName}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Target workspace</span>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <p className="dim text-[13px]">
          The repo leaves <strong>{workspaces.find((w) => w.id === repo.workspaceId)?.name}</strong> together with its
          issues, PRs, and pipeline scope.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !target}>
            {busy ? 'Transferring…' : 'Transfer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddRepoModal({
  workspace,
  onClose,
  onDone,
}: {
  workspace: WorkspaceRecord;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addRepo(fullName.trim(), workspace.id);
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Connect a repository — ${workspace.name}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Repository (owner/name)</span>
          <input
            className="input"
            required
            pattern="[\w.-]+/[\w.-]+"
            placeholder="vercel/next.js"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoFocus
          />
        </label>
        <p className="dim text-[13px]">
          The repo connects into <strong>{workspace.name}</strong> — the active workspace. You can move it later from
          its row.
        </p>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !fullName.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspaceSettingsModal({
  workspace,
  repoCount,
  canDelete,
  onClose,
  onChanged,
  onDeleted,
}: {
  workspace: WorkspaceRecord;
  repoCount: number;
  canDelete: boolean;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rename = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateWorkspace(workspace.id, { name: name.trim() });
      setNote('Saved.');
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const { confirmDanger, confirmElement } = useConfirm();

  const remove = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete workspace ${workspace.name}`,
      message: `"${workspace.name}" is removed permanently, together with its pipelines and step library.`,
    });
    if (!ok) return;
    setError(null);
    try {
      await api.deleteWorkspace(workspace.id);
      onDeleted();
    } catch (err) {
      setError(String(err));
    }
  };

  const deleteBlocked = repoCount > 0 ? 'Move or remove its repos first' : !canDelete ? 'The last workspace cannot be deleted' : null;

  return (
    <Modal title={`Workspace settings — ${workspace.name}`} onClose={onClose}>
      <form className="flex items-end gap-2" onSubmit={(e) => void rename(e)}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="dim">Name</span>
          <input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn py-2" type="submit" disabled={busy || name.trim().length < 2 || name.trim() === workspace.name}>
          {busy ? 'Saving…' : 'Rename'}
        </button>
      </form>
      {note ? <p className="mt-2 text-[13px] text-emerald-600 dark:text-emerald-400">{note}</p> : null}

      <div className="mt-4 rounded-lg border border-red-500/40 p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Delete this workspace</div>
            <p className="dim mt-0.5">
              {deleteBlocked ?? `Removes "${workspace.name}" permanently. Pipelines and step library go with it.`}
            </p>
          </div>
          <button className="btn-danger-ghost" disabled={deleteBlocked !== null} title={deleteBlocked ?? undefined} onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
      {error ? <div className="error-bar mt-2">{error}</div> : null}
      {confirmElement}
    </Modal>
  );
}
