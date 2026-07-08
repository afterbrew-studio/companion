import { useCallback, useEffect, useState } from 'react';
import type {
  GitHubAccountRecord,
  GitHubAccountScope,
  GitHubPurpose,
  MoxxyStatus,
  WorkspaceRecord,
} from '@companion/contract';
import { GITHUB_PURPOSES } from '@companion/contract';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useGithubAccounts } from '../hooks/useGithubAccounts.js';
import { useIntent } from '../lib/intents.js';
import { Page, EmptyState, Modal, PageHeader, Switch, timeAgo, useConfirm } from '../components/ui.js';

const PURPOSE_META: Record<GitHubPurpose, { label: string; hint: string }> = {
  fetch: { label: 'Fetches & sync', hint: 'Issue/PR sync and CI check snapshots run as this account.' },
  runs: { label: 'Agent runs', hint: 'Clones and branch pushes from fix/implement runs use this token.' },
  pipelines: { label: 'Pipelines & reviews', hint: 'Reviews, labels, and comments are posted as this account.' },
  webhooks: { label: 'Webhooks', hint: 'Webhook-triggered activity is attributed to this account.' },
};

/**
 * Connected GitHub accounts, each bound to what it does and where it may act.
 * A purpose with no bound account falls back to the first connected account,
 * so a single shared account with everything on is the simple default.
 * Delegated accounts only act for repos in their workspaces.
 */
export function GithubAccountsPage(): JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canManage = (a: GitHubAccountRecord): boolean => isAdmin || a.ownerId === user?.username;
  const ownerLabel = (a: GitHubAccountRecord): string =>
    a.ownerId === null ? 'shared default' : a.ownerId === user?.username ? 'your account' : `owned by @${a.ownerId}`;
  const { accounts, workspaces, status, error, setError, refresh } = useGithubAccounts();
  const [adding, setAdding] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();

  // ⌘K → "Connect GitHub account" lands here and opens the connect modal.
  useIntent('connect-github', () => setAdding(true));

  const togglePurpose = async (account: GitHubAccountRecord, purpose: GitHubPurpose): Promise<void> => {
    const next = account.purposes.includes(purpose)
      ? account.purposes.filter((p) => p !== purpose)
      : [...account.purposes, purpose];
    if (next.length === 0) {
      setError('An account needs at least one purpose — disconnect it instead.');
      return;
    }
    setError(null);
    try {
      await api.updateGithubAccount(account.id, { purposes: next });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (account: GitHubAccountRecord): Promise<void> => {
    const ok = await confirmDanger({
      title: `Disconnect ${account.login || 'account'}`,
      message:
        'Everything bound to this account falls back to the first remaining one. With no accounts left, sync and agent pushes stop.',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    setError(null);
    try {
      await api.removeGithubAccount(account.id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="GitHub accounts"
        subtitle={
          isAdmin
            ? status?.githubConfigured
              ? `Connected — default fetches run as ${status.githubUser ?? '…'}. Your own actions use your account when connected.`
              : 'Connect fine-grained PATs — shared defaults for the instance, or your own account for your actions.'
            : 'Connect your own GitHub account — your issue comments, reviews, and merges act as you. Unconnected, they use the shared default.'
        }
        actions={
          <button className="btn" onClick={() => setAdding(true)}>
            Connect account
          </button>
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      {accounts === null ? null : accounts.length === 0 ? (
        <EmptyState
          title="No GitHub accounts connected"
          hint="Connect a fine-grained PAT with Contents / Issues / Pull requests read-write and Metadata read."
          action={
            <button className="btn" onClick={() => setAdding(true)}>
              Connect the first account
            </button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {accounts.map((a) => {
            const manageable = canManage(a);
            return (
              <article key={a.id} className="card" aria-label={a.login || 'validating account'}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
                    <GitHubIcon />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{a.login || 'validating…'}</span>
                      <span className={a.ownerId === null ? 'badge-ok' : 'badge'}>{ownerLabel(a)}</span>
                    </div>
                    <div className="dim text-xs">
                      connected {timeAgo(a.createdAt)} ·{' '}
                      {a.scope === 'shared'
                        ? 'shared'
                        : `delegated to ${a.workspaceIds.length} ${a.workspaceIds.length === 1 ? 'workspace' : 'workspaces'}`}
                    </div>
                  </div>
                  {manageable ? (
                    <button className="btn-danger-ghost" onClick={() => void remove(a)}>
                      Disconnect
                    </button>
                  ) : null}
                </div>
                {manageable ? (
                  <>
                    <div className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800/60 dark:border-zinc-800">
                      {GITHUB_PURPOSES.map((purpose) => (
                        <div key={purpose} className="flex items-center gap-3 px-3.5 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium">{PURPOSE_META[purpose].label}</div>
                            <p className="dim mt-0.5">{PURPOSE_META[purpose].hint}</p>
                          </div>
                          <Switch
                            label={`${PURPOSE_META[purpose].label} via ${a.login}`}
                            checked={a.purposes.includes(purpose)}
                            onChange={() => void togglePurpose(a, purpose)}
                          />
                        </div>
                      ))}
                    </div>
                    <ScopeEditor account={a} workspaces={workspaces} onError={setError} onSaved={refresh} />
                  </>
                ) : (
                  // Read-only: a shared default (or another user's account, for admins is manageable).
                  <p className="dim mt-2 text-xs">
                    The shared default — your own actions use it unless you connect your own account. Handles{' '}
                    {a.purposes.map((p) => PURPOSE_META[p].label.toLowerCase()).join(', ') || 'nothing'}.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {adding ? (
        <ConnectAccountModal
          workspaces={workspaces}
          isAdmin={isAdmin}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void refresh();
          }}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

/**
 * Where the account may act, saved on change. Flipping to "delegated" waits
 * for the first workspace pick before saving — the server (rightly) rejects a
 * delegated account with no workspaces.
 */
function ScopeEditor({
  account,
  workspaces,
  onError,
  onSaved,
}: {
  account: GitHubAccountRecord;
  workspaces: readonly WorkspaceRecord[];
  onError: (e: string | null) => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const delegated = account.scope === 'delegated';
  const [pendingDelegated, setPendingDelegated] = useState(false);
  const showWorkspaces = delegated || pendingDelegated;

  const save = async (scope: GitHubAccountScope, workspaceIds: readonly string[]): Promise<void> => {
    onError(null);
    try {
      await api.updateGithubAccount(account.id, { scope, workspaceIds });
      setPendingDelegated(false);
      await onSaved();
    } catch (err) {
      onError(String(err));
    }
  };

  const toggleWorkspace = (id: string, checked: boolean): void => {
    const next = checked ? [...account.workspaceIds, id] : account.workspaceIds.filter((w) => w !== id);
    if (delegated && next.length === 0) {
      onError('A delegated account needs at least one workspace — switch it to shared instead.');
      return;
    }
    void save('delegated', next);
  };

  return (
    <fieldset className="mt-3 flex flex-col gap-1.5">
      <legend className="dim mb-1 text-sm">Available to</legend>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="radio"
          name={`scope-${account.id}`}
          checked={!showWorkspaces}
          onChange={() => {
            setPendingDelegated(false);
            if (delegated) void save('shared', []);
            else onError(null);
          }}
        />
        Shared
        <span className="dim text-xs">— acts for any workspace</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="radio"
          name={`scope-${account.id}`}
          checked={showWorkspaces}
          onChange={() => {
            onError(null);
            setPendingDelegated(true);
          }}
        />
        Delegated
        <span className="dim text-xs">— only the workspaces picked below</span>
      </label>
      {showWorkspaces ? (
        <div className="ml-6 flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          {workspaces.length === 0 ? <span className="dim text-sm">No workspaces found.</span> : null}
          {pendingDelegated && !delegated ? (
            <span className="dim text-xs">Pick at least one workspace to delegate this account.</span>
          ) : null}
          {workspaces.map((w) => (
            <label key={w.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={account.workspaceIds.includes(w.id)}
                onChange={(e) => toggleWorkspace(w.id, e.target.checked)}
              />
              {w.name}
            </label>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

function ConnectAccountModal({
  workspaces,
  isAdmin,
  onClose,
  onDone,
}: {
  workspaces: readonly WorkspaceRecord[];
  isAdmin: boolean;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [purposes, setPurposes] = useState<readonly GitHubPurpose[]>(GITHUB_PURPOSES);
  const [scope, setScope] = useState<GitHubAccountScope>('shared');
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>([]);
  // Admins default to a shared instance default; a maintainer's account is always personal.
  const [shared, setShared] = useState(isAdmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delegatedEmpty = scope === 'delegated' && workspaceIds.length === 0;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (delegatedEmpty) {
      setError('A delegated account needs at least one workspace.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addGithubAccount(token.trim(), purposes, scope, scope === 'delegated' ? workspaceIds : [], isAdmin && shared);
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect a GitHub account" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        {isAdmin ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="dim mb-1 text-sm">Ownership</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="own" checked={shared} onChange={() => setShared(true)} />
              Shared default
              <span className="dim text-xs">— the instance-wide fallback everyone's actions use</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="own" checked={!shared} onChange={() => setShared(false)} />
              My account
              <span className="dim text-xs">— only my own actions act as this account</span>
            </label>
          </fieldset>
        ) : (
          <p className="dim text-xs">
            This connects as <span className="font-medium">your</span> account — your comments, reviews, and merges act
            as you. Other work still uses the shared default.
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">
            Fine-grained PAT — Contents / Issues / Pull requests read-write, Metadata read
          </span>
          <input
            className="input"
            type="password"
            required
            placeholder="github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="dim mb-1 text-sm">This account handles</legend>
          {GITHUB_PURPOSES.map((purpose) => (
            <label key={purpose} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={purposes.includes(purpose)}
                onChange={(e) =>
                  setPurposes((prev) =>
                    e.target.checked ? [...prev, purpose] : prev.filter((p) => p !== purpose),
                  )
                }
              />
              {PURPOSE_META[purpose].label}
              <span className="dim text-xs">— {PURPOSE_META[purpose].hint}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="dim mb-1 text-sm">Available to</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="scope" checked={scope === 'shared'} onChange={() => setScope('shared')} />
            Shared
            <span className="dim text-xs">— acts for any workspace</span>
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
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="submit"
            disabled={busy || token.trim().length < 10 || purposes.length === 0 || delegatedEmpty}
          >
            {busy ? 'Validating…' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GitHubIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
