import { useCallback, useEffect, useState } from 'react';
import type { GitHubAccountRecord, GitHubPurpose, MoxxyStatus } from '@companion/contract';
import { GITHUB_PURPOSES } from '@companion/contract';
import { api } from '../lib/api.js';
import { Page, EmptyState, Modal, PageHeader, Switch, timeAgo, useConfirm } from '../components/ui.js';

const PURPOSE_META: Record<GitHubPurpose, { label: string; hint: string }> = {
  fetch: { label: 'Fetches & sync', hint: 'Issue/PR sync and CI check snapshots run as this account.' },
  runs: { label: 'Agent runs', hint: 'Clones and branch pushes from fix/implement runs use this token.' },
  pipelines: { label: 'Pipelines & reviews', hint: 'Reviews, labels, and comments are posted as this account.' },
  webhooks: { label: 'Webhooks', hint: 'Webhook-triggered activity is attributed to this account.' },
};

/**
 * Connected GitHub accounts, each bound to what it does. A purpose with no
 * bound account falls back to the first connected account, so a single
 * account with everything on is the simple default.
 */
export function GithubAccountsPage(): JSX.Element {
  const [accounts, setAccounts] = useState<GitHubAccountRecord[] | null>(null);
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const [{ accounts }, st] = await Promise.all([api.listGithubAccounts(), api.status().catch(() => null)]);
      setAccounts(accounts);
      setStatus(st);
      setError(null);
    } catch (err) {
      setError(String(err));
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      await api.updateGithubAccount(account.id, next);
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
          status?.githubConfigured
            ? `Connected — fetches run as ${status.githubUser ?? '…'}. Unbound purposes fall back to the first account.`
            : 'Connect fine-grained PATs and bind each account to what it does.'
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
          {accounts.map((a) => (
            <article key={a.id} className="card" aria-label={a.login || 'validating account'}>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
                  <GitHubIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.login || 'validating…'}</div>
                  <div className="dim text-xs">connected {timeAgo(a.createdAt)}</div>
                </div>
                <button className="btn-danger" onClick={() => void remove(a)}>
                  Disconnect
                </button>
              </div>
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
            </article>
          ))}
        </div>
      )}

      {adding ? (
        <ConnectAccountModal
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

function ConnectAccountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [token, setToken] = useState('');
  const [purposes, setPurposes] = useState<readonly GitHubPurpose[]>(GITHUB_PURPOSES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addGithubAccount(token.trim(), purposes);
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect a GitHub account" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
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
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || token.trim().length < 10 || purposes.length === 0}>
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
