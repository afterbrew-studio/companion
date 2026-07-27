import { useState } from 'react';
import { useIntent } from '@moxxy-ai/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { isAmbiguousWorkspaceName } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import {
  Dropdown,
  EmptyState,
  ErrorBar,
  Eyebrow,
  Field,
  FormActions,
  ListCard,
  Modal,
  Page,
  PageHeader,
  RowsSkeleton,
  SettingRow,
  Switch,
  timeAgo,
  useConfirm,
} from '@moxxy-ai/companion-sdk/ui';
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
 * A user's personal GitHub accounts, each bound to what it does and which of
 * that user's workspaces it may serve. Credentials are never shared between
 * Companion profiles.
 */
export function GithubAccountsPage(): JSX.Element {
  const { user } = useAuth();
  const canManage = (a: GitHubAccountRecord): boolean => a.ownerId === user?.username;
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
          status?.githubConfigured
            ? `Connected as ${status.githubUser ?? '…'} — only your accounts can read, clone, push, or act on GitHub.`
            : 'Connect one or more of your GitHub accounts. No other Companion profile can use their credentials.'
        }
        actions={
          <button className="btn" onClick={() => setAdding(true)}>
            Connect account
          </button>
        }
      />
      <ErrorBar error={error} />

      {accounts === null ? (
        <div className="card">
          <RowsSkeleton rows={2} />
        </div>
      ) : accounts.length === 0 ? (
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
                    <div className="truncate text-sm font-medium">{a.login || 'validating…'}</div>
                    <div className="dim text-xs">
                      your personal account · connected {timeAgo(a.createdAt)} ·{' '}
                      {a.scope === 'all'
                        ? 'available in all your workspaces'
                        : `available in ${a.workspaceIds.length} ${a.workspaceIds.length === 1 ? 'workspace' : 'workspaces'}`}
                    </div>
                  </div>
                  {manageable ? (
                    <button className="btn-danger-ghost" onClick={() => void remove(a)}>
                      Disconnect
                    </button>
                  ) : null}
                </div>
                {manageable ? (
                  <ListCard subtle className="mt-3">
                    {GITHUB_PURPOSES.map((purpose) => (
                      <PurposeRow
                        key={purpose}
                        purpose={purpose}
                        checked={a.purposes.includes(purpose)}
                        switchLabel={`${PURPOSE_META[purpose].label} via ${a.login}`}
                        onChange={() => void togglePurpose(a, purpose)}
                      />
                    ))}
                    <ScopeEditor account={a} workspaces={workspaces} onError={setError} onSaved={refresh} />
                  </ListCard>
                ) : (
                  <p className="dim mt-2 text-xs">
                    Your personal credential handles{' '}
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
 * Which of the owner's workspaces may use this personal account.
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
  const selected = account.scope === 'selected';
  const [pendingSelected, setPendingSelected] = useState(false);
  const showWorkspaces = selected || pendingSelected;

  const save = async (scope: GitHubAccountScope, workspaceIds: readonly string[]): Promise<void> => {
    onError(null);
    try {
      await api.updateGithubAccount(account.id, { scope, workspaceIds });
      setPendingSelected(false);
      await onSaved();
    } catch (err) {
      onError(String(err));
    }
  };

  const toggleWorkspace = (id: string, checked: boolean): void => {
    const next = checked ? [...account.workspaceIds, id] : account.workspaceIds.filter((w) => w !== id);
    if (selected && next.length === 0) {
      onError('Choose at least one workspace, or make the account available in all your workspaces.');
      return;
    }
    void save('selected', next);
  };

  return (
    <>
      <SettingRow
        className="px-3.5 py-2.5"
        title="Available to"
        description={showWorkspaces ? 'Only the workspaces picked below.' : 'All workspaces you can access.'}
      >
        <Dropdown
          className="w-40"
          ariaLabel={`Where ${account.login || 'this account'} may act`}
          value={showWorkspaces ? 'selected' : 'all'}
          onChange={(v) => {
            if (v === 'all') {
              setPendingSelected(false);
              if (selected) void save('all', []);
              else onError(null);
            } else {
              onError(null);
              setPendingSelected(true);
            }
          }}
          options={SCOPE_OPTIONS}
        />
      </SettingRow>
      {showWorkspaces ? (
        <div className="px-3.5 py-2.5">
          <WorkspaceChecklist
            workspaces={workspaces}
            selected={account.workspaceIds}
            onToggle={toggleWorkspace}
            note={pendingSelected && !selected ? 'Pick at least one workspace for this account.' : undefined}
          />
        </div>
      ) : null}
    </>
  );
}

function ConnectAccountModal({
  workspaces,
  onClose,
  onDone,
}: {
  workspaces: readonly WorkspaceRecord[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [purposes, setPurposes] = useState<readonly GitHubPurpose[]>(GITHUB_PURPOSES);
  const [scope, setScope] = useState<GitHubAccountScope>('all');
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEmpty = scope === 'selected' && workspaceIds.length === 0;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (selectedEmpty) {
      setError('Choose at least one workspace for this account.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addGithubAccount(token.trim(), purposes, scope, scope === 'selected' ? workspaceIds : []);
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
        <Field
          label="Fine-grained personal access token"
          hint={
            <>
              Needs Contents, Issues, and Pull requests <span className="font-medium">read-write</span>, plus Metadata read.
            </>
          }
        >
          <input
            className="input font-mono"
            type="password"
            required
            placeholder="github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
        </Field>

        {/* Two columns: what the account DOES (left) vs who it IS + where it applies (right). */}
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
          <FieldGroup label="This account handles">
            <ListCard subtle>
              {GITHUB_PURPOSES.map((purpose) => (
                <PurposeRow
                  key={purpose}
                  purpose={purpose}
                  checked={purposes.includes(purpose)}
                  switchLabel={PURPOSE_META[purpose].label}
                  onChange={(on) =>
                    setPurposes((prev) => (on ? [...prev, purpose] : prev.filter((p) => p !== purpose)))
                  }
                />
              ))}
            </ListCard>
          </FieldGroup>

          <div className="flex flex-col gap-5">
            <p className="dim well text-xs leading-relaxed">
              This credential belongs only to <span className="font-medium">your Companion profile</span>. Other users
              cannot read, clone, push, comment, review, or run agents through it.
            </p>

            <FieldGroup label="Available to">
              <Dropdown ariaLabel="Available to" value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
              <span className="dim text-xs leading-relaxed">
                {scope === 'all' ? 'All workspaces you can access.' : 'Only the workspaces selected below.'}
              </span>
              {scope === 'selected' ? (
                <WorkspaceChecklist
                  workspaces={workspaces}
                  selected={workspaceIds}
                  onToggle={(id, on) =>
                    setWorkspaceIds((prev) => (on ? [...prev, id] : prev.filter((w) => w !== id)))
                  }
                />
              ) : null}
            </FieldGroup>
          </div>
        </div>

        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="submit"
            disabled={busy || token.trim().length < 10 || purposes.length === 0 || selectedEmpty}
          >
            {busy ? 'Validating…' : 'Connect'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/** A titled form group with a small uppercase section header. */
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>{label}</Eyebrow>
      {children}
    </div>
  );
}

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All my workspaces', hint: 'Available anywhere your profile has access.' },
  { value: 'selected', label: 'Selected workspaces', hint: 'Only the workspaces picked below.' },
] as const satisfies ReadonlyArray<{ value: GitHubAccountScope; label: string; hint: string }>;

/** One purpose row for the account's settings list: name + meaning, toggle trailing. */
function PurposeRow({
  purpose,
  checked,
  switchLabel,
  onChange,
}: {
  purpose: GitHubPurpose;
  checked: boolean;
  switchLabel: string;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <SettingRow className="px-3.5 py-2.5" title={PURPOSE_META[purpose].label} description={PURPOSE_META[purpose].hint}>
      <Switch label={switchLabel} checked={checked} onChange={onChange} />
    </SettingRow>
  );
}

/** Bordered scrolling workspace multi-pick shared by the modal and the inline editor. */
function WorkspaceChecklist({
  workspaces,
  selected,
  onToggle,
  note,
}: {
  workspaces: readonly WorkspaceRecord[];
  selected: readonly string[];
  onToggle: (id: string, checked: boolean) => void;
  note?: string;
}): JSX.Element {
  return (
    <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
      {workspaces.length === 0 ? <span className="dim px-1 py-2 text-sm">No workspaces found.</span> : null}
      {note ? <span className="dim px-1 pt-1 text-xs">{note}</span> : null}
      {workspaces.map((w) => (
        <label
          key={w.id}
          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
        >
          <input type="checkbox" checked={selected.includes(w.id)} onChange={(e) => onToggle(w.id, e.target.checked)} />
          {w.name}
          {isAmbiguousWorkspaceName(w, workspaces) ? <span className="dim text-xs">{w.slug}</span> : null}
        </label>
      ))}
    </div>
  );
}

function GitHubIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
