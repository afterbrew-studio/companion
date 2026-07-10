import { useState } from 'react';
import { useIntent } from '@companion/core/client';
import { useAuth } from '@companion/module-core/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import { EmptyState, Modal, Page, PageHeader, Switch, timeAgo, useConfirm } from '@companion/ui';
import type { GitHubAccountRecord, GitHubAccountScope, GitHubPurpose } from '../../contract/index.js';
import { GITHUB_PURPOSES } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { useGithubAccounts } from '../hooks/useGithubAccounts.js';

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
    <div className="mt-3">
      <Section label="Available to">
        <div className="grid gap-2 sm:grid-cols-2">
          <OptionRow
            active={!showWorkspaces}
            control={
              <input
                type="radio"
                name={`scope-${account.id}`}
                className="accent-emerald-600"
                checked={!showWorkspaces}
                onChange={() => {
                  setPendingDelegated(false);
                  if (delegated) void save('shared', []);
                  else onError(null);
                }}
              />
            }
            title="Shared"
            hint="Acts for any workspace."
          />
          <OptionRow
            active={showWorkspaces}
            control={
              <input
                type="radio"
                name={`scope-${account.id}`}
                className="accent-emerald-600"
                checked={showWorkspaces}
                onChange={() => {
                  onError(null);
                  setPendingDelegated(true);
                }}
              />
            }
            title="Delegated"
            hint="Only the workspaces picked below."
          />
        </div>
        {showWorkspaces ? (
          <div className="mt-2 flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            {workspaces.length === 0 ? <span className="dim px-1 py-2 text-sm">No workspaces found.</span> : null}
            {pendingDelegated && !delegated ? (
              <span className="dim px-1 pt-1 text-xs">Pick at least one workspace to delegate this account.</span>
            ) : null}
            {workspaces.map((w) => (
              <label
                key={w.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
              >
                <input
                  type="checkbox"
                  className="accent-emerald-600"
                  checked={account.workspaceIds.includes(w.id)}
                  onChange={(e) => toggleWorkspace(w.id, e.target.checked)}
                />
                {w.name}
              </label>
            ))}
          </div>
        ) : null}
      </Section>
    </div>
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
    <Modal wide title="Connect a GitHub account" onClose={onClose}>
      <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
        {/* Fine-grained PAT — the one required field, spanning the top. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Fine-grained personal access token</span>
          <input
            className="input font-mono"
            type="password"
            required
            placeholder="github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          <span className="dim text-xs leading-relaxed">
            Needs Contents, Issues, and Pull requests <span className="font-medium">read-write</span>, plus Metadata read.
          </span>
        </label>

        {/* Two columns: what the account DOES (left) vs who it IS + where it applies (right). */}
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
          <Section label="This account handles">
            <div className="flex flex-col gap-2">
              {GITHUB_PURPOSES.map((purpose) => (
                <OptionRow
                  key={purpose}
                  active={purposes.includes(purpose)}
                  control={
                    <input
                      type="checkbox"
                      className="accent-emerald-600"
                      checked={purposes.includes(purpose)}
                      onChange={(e) =>
                        setPurposes((prev) => (e.target.checked ? [...prev, purpose] : prev.filter((p) => p !== purpose)))
                      }
                    />
                  }
                  title={PURPOSE_META[purpose].label}
                  hint={PURPOSE_META[purpose].hint}
                />
              ))}
            </div>
          </Section>

          <div className="flex flex-col gap-5">
            {isAdmin ? (
              <Section label="Ownership">
                <div className="flex flex-col gap-2">
                  <OptionRow
                    active={shared}
                    control={<input type="radio" name="own" className="accent-emerald-600" checked={shared} onChange={() => setShared(true)} />}
                    title="Shared default"
                    hint="The instance-wide fallback everyone's actions use."
                  />
                  <OptionRow
                    active={!shared}
                    control={<input type="radio" name="own" className="accent-emerald-600" checked={!shared} onChange={() => setShared(false)} />}
                    title="My account"
                    hint="Only my own actions act as this account."
                  />
                </div>
              </Section>
            ) : (
              <p className="dim rounded-lg bg-zinc-50 px-3 py-2.5 text-xs leading-relaxed dark:bg-zinc-900/50">
                This connects as <span className="font-medium">your</span> account — your comments, reviews, and merges
                act as you. Other work still uses the shared default.
              </p>
            )}

            <Section label="Available to">
              <div className="flex flex-col gap-2">
                <OptionRow
                  active={scope === 'shared'}
                  control={<input type="radio" name="scope" className="accent-emerald-600" checked={scope === 'shared'} onChange={() => setScope('shared')} />}
                  title="Shared"
                  hint="Acts for any workspace."
                />
                <OptionRow
                  active={scope === 'delegated'}
                  control={<input type="radio" name="scope" className="accent-emerald-600" checked={scope === 'delegated'} onChange={() => setScope('delegated')} />}
                  title="Delegated"
                  hint="Only the workspaces picked below."
                />
              </div>
              {scope === 'delegated' ? (
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {workspaces.length === 0 ? <span className="dim px-1 py-2 text-sm">No workspaces found.</span> : null}
                  {workspaces.map((w) => (
                    <label
                      key={w.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                    >
                      <input
                        type="checkbox"
                        className="accent-emerald-600"
                        checked={workspaceIds.includes(w.id)}
                        onChange={(e) =>
                          setWorkspaceIds((prev) => (e.target.checked ? [...prev, w.id] : prev.filter((id) => id !== w.id)))
                        }
                      />
                      {w.name}
                    </label>
                  ))}
                </div>
              ) : null}
            </Section>
          </div>
        </div>

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

/** A titled form group with a small uppercase section header. */
function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">{label}</span>
      {children}
    </div>
  );
}

/** A selectable option: control + stacked title/hint in a card that highlights
 *  when active (works for radio or checkbox — the title never wraps into the hint). */
function OptionRow({
  active,
  control,
  title,
  hint,
}: {
  active: boolean;
  control: React.ReactNode;
  title: string;
  hint: string;
}): JSX.Element {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
        active
          ? 'border-emerald-500/50 bg-emerald-500/[0.06]'
          : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40'
      }`}
    >
      <span className="mt-0.5 shrink-0">{control}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="dim text-xs leading-relaxed">{hint}</span>
      </span>
    </label>
  );
}

function GitHubIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
