import { useEffect, useRef, useState } from 'react';
import { runIntent, useIntent } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import type { RunnerRecord } from '@companion/module-operate/contract';
import { useWorkspace, useWorkspaceMembers, workspaceApi, workspaceLabel } from '@companion/module-workspace/client';
import type { WorkspaceMemberCandidate, WorkspaceRecord, WorkspaceVisibility } from '@companion/module-workspace/contract';
import {
  Avatar,
  CardActions,
  CloseIcon,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  LockIcon,
  Modal,
  Page,
  PageHeader,
  RowsSkeleton,
  Spinner,
  Tabs,
  timeAgo,
  useConfirm,
  useDebounced,
} from '@moxxy/companion-sdk/ui';
import type {
  RepoAgentContext,
  RepoAgentContextFile,
  RepoCandidate,
  RepoRecord,
} from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { RepoAccountPicker } from '../components/RepoAccountPicker.js';
import { useReposAdmin } from '../hooks/useReposAdmin.js';

/**
 * Repository management, scoped to the active workspace. A repository may be
 * connected to several workspaces; transfer moves only this membership.
 */
export function ReposPage(): JSX.Element {
  const { can, user } = useAuth();
  const { workspaces, current, setCurrent, refresh: refreshWorkspaces } = useWorkspace();
  const canManageRepos = can('repos:manage');
  // Readers inspect the workspace foundation. Mutations additionally require
  // repos:manage; workspace metadata is limited to an admin or its owner.
  const canManageCurrent =
    canManageRepos && (can('workspaces:manage') || (!!current?.ownerId && current.ownerId === user?.username));
  const { repos, loaded, runners, error, setError, refresh } = useReposAdmin();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);

  // New / command search → "Connect repository" lands here and opens the form.
  useIntent('connect-repo', () => canManageRepos && setAdding(true));

  if (!current) {
    return (
      <Page>
        <EmptyState
          title="No workspace yet"
          hint="Create a workspace first; this repository form will stay ready for the next step."
          action={
            can('workspaces:create') ? (
              <button className="btn" onClick={() => runIntent('new-workspace')}>Create workspace</button>
            ) : undefined
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Repositories"
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            {current.visibility === 'private' ? <LockIcon className="dim size-3.5" /> : null}
            {current.name} — connected GitHub repositories in this {current.visibility} workspace
          </span>
        }
        actions={
          <>
            {canManageCurrent ? (
              <button className="btn-ghost" onClick={() => setManaging(true)}>
                Workspace settings
              </button>
            ) : null}
            {canManageRepos ? (
              <button className="btn" onClick={() => setAdding(true)}>
                Connect repo
              </button>
            ) : null}
          </>
        }
      />
      <ErrorBar error={error} />

      {!loaded ? (
        <div className="card">
          <RowsSkeleton rows={3} />
        </div>
      ) : repos.length > 0 ? (
        <div className="flex flex-col gap-3">
          {repos.map((repo) => (
            <RepoCard
              key={repo.fullName}
              repo={repo}
              workspaces={workspaces}
              runners={runners}
              canManage={canManageRepos}
              onChange={refresh}
              onError={setError}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No repositories in this workspace"
          hint="Connect a GitHub repository to start syncing issues and pull requests."
          action={canManageRepos ? (
            <button className="btn" onClick={() => setAdding(true)}>
              Connect the first repo
            </button>
          ) : undefined}
        />
      )}

      {adding && canManageRepos ? (
        <AddRepoModal
          workspace={current}
          existing={repos}
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
            if (next) setCurrent(next.id, { navigate: false });
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
  runners,
  canManage,
  onChange,
  onError,
}: {
  repo: RepoRecord;
  workspaces: readonly WorkspaceRecord[];
  runners: readonly RunnerRecord[];
  canManage: boolean;
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}): JSX.Element {
  const { githubHost } = useAuth();
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
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

  const disconnect = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: `Disconnect ${repo.fullName}`,
      message:
        'The repository is removed from this workspace. Shared cached data and the local clone remain while another workspace still uses it.',
      confirmLabel: 'Disconnect',
    });
    if (ok) await act(() => api.removeRepo(repo.fullName, repo.workspaceId))();
  };

  if (!repo.githubAccessible) {
    return (
      <article className="card opacity-70" aria-label={`${repo.fullName} — no GitHub access`}>
        <div className="flex items-start gap-3 text-zinc-500 dark:text-zinc-500">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-zinc-300 dark:border-zinc-700">
            <LockIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-zinc-600 dark:text-zinc-400">{repo.fullName}</div>
            <p className="mt-1 text-xs leading-relaxed">
              None of your personal GitHub accounts can access this repository. Ask its owner to grant your GitHub
              account access, then refresh. Cached repository data and another user's credentials stay hidden.
            </p>
          </div>
        </div>
        <CardActions>
          <span className="dim mr-auto text-xs">GitHub actions are unavailable for this repository.</span>
          {canManage ? (
            <button className="btn-danger-ghost" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Working…' : 'Remove from workspace'}
            </button>
          ) : null}
        </CardActions>
        {confirmElement}
      </article>
    );
  }

  const automations: ReadonlyArray<{ label: string; on: boolean }> = [
    { label: 'auto-triage', on: repo.autoTriage },
    { label: 'PR gate', on: repo.prGateEnabled },
    { label: 'auto-merge', on: repo.autoMergeEnabled },
    { label: 'review replies', on: repo.reviewRepliesEnabled },
    { label: 'digest', on: repo.digestEnabled },
    { label: 'stale sweep', on: repo.staleSweepEnabled },
    { label: 'webhook', on: repo.webhookConfigured },
  ];

  return (
    <article className="card" aria-label={repo.fullName}>
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="font-medium hover:underline"
          href={`https://${githubHost}/${repo.fullName}`}
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

      {/* What proves an agent's diff builds here, before anybody reads it. Blank
          means nothing is checked, which the review card reports as such rather
          than as a pass. */}
      {canManage ? (
        <label className="mt-3 flex flex-col gap-1 text-xs">
          <span className="dim">Verification command</span>
          <input
            className="input font-mono text-[12px]"
            defaultValue={repo.verifyCommand ?? ''}
            disabled={busy}
            placeholder="pnpm -s typecheck"
            aria-label={`Verification command for ${repo.fullName}`}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next === (repo.verifyCommand ?? '')) return;
              void act(() => api.setVerifyCommand(repo.fullName, next))();
            }}
          />
        </label>
      ) : null}

      <CardActions>
        <button className="btn-ghost mr-auto" onClick={() => setContextOpen(true)}>
          Agent context
        </button>
        {canManage ? (
          <>
            <button className="btn-ghost" disabled={busy} onClick={() => void act(() => api.syncRepo(repo.fullName))()}>
              {busy ? 'Working…' : 'Sync now'}
            </button>
            <button className="btn-ghost" disabled={busy || workspaces.length < 2} title={workspaces.length < 2 ? 'Create another workspace to transfer' : undefined} onClick={() => setTransferring(true)}>
              Transfer…
            </button>
            {/* Which of the viewer's own credentials acts here. Renders nothing
                when they have only one — then there is no decision to make. */}
            <RepoAccountPicker repo={repo.fullName} className="w-44" />
            {/* A pin is pointless while only the local runner exists — hide it. */}
            {runners.length > 1 ? (
              <select
                className="input"
                value={repo.runnerId ?? ''}
                disabled={busy}
                aria-label={`Runner executing agent work for ${repo.fullName}`}
                title="Agent runs for this repo execute on this machine"
                onChange={(e) => void act(() => api.setRepoRunner(repo.fullName, e.target.value || null))()}
              >
                <optgroup label="Runs on — agent runs for this repo execute on this machine">
                  <option value="">auto (place among eligible)</option>
                  {runners.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            ) : null}
            <span className="action-sep" aria-hidden />
            <button className="btn-danger-ghost" disabled={busy} onClick={() => void disconnect()}>
              Remove
            </button>
          </>
        ) : null}
      </CardActions>
      {confirmElement}

      {contextOpen ? <AgentContextModal repo={repo} onClose={() => setContextOpen(false)} /> : null}

      {transferring && canManage ? (
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

type AgentContextTab = 'rules' | 'skills' | 'template';

/** Inspect the exact base-branch guidance Companion applies to this repo. */
function AgentContextModal({ repo, onClose }: { repo: RepoRecord; onClose: () => void }): JSX.Element {
  const [context, setContext] = useState<RepoAgentContext | null>(null);
  const [tab, setTab] = useState<AgentContextTab>('rules');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (refresh = false): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.repoAgentContext(repo.fullName, refresh);
      setContext(result.context);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [repo.fullName]);

  const rules = context?.files.filter((file) => file.kind === 'instructions') ?? [];
  const skills = context?.files.filter((file) => file.kind === 'skill') ?? [];
  const templates = context?.files.filter((file) => file.kind === 'pull-request-template') ?? [];
  const primaryTemplate = templates.find((file) => file.primary);
  const templateApplied = Boolean(primaryTemplate?.content.trim());
  const shown = tab === 'rules' ? rules : tab === 'skills' ? skills : templates;

  return (
    <Modal title={`Agent context · ${repo.fullName}`} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            Companion scans the trusted base branch and uses this same bounded context pipeline for implementation,
            PR-repair and publishing flows. Repository code, hooks, plugins and MCP servers are never executed by this
            scan.
          </div>
          <button className="btn-ghost shrink-0" disabled={loading} onClick={() => void load(true)}>
            {loading && context ? <Spinner /> : null} Rescan
          </button>
        </div>

        <ErrorBar error={error} />
        {loading && !context ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-500">
            <Spinner /> Scanning {repo.defaultBranch}…
          </div>
        ) : context ? (
          <>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="badge-ok normal-case">✓ trusted origin/{context.ref}</span>
                <span className="badge-ok normal-case">✓ no AI attribution</span>
                <span className={templateApplied ? 'badge-ok normal-case' : 'badge normal-case'}>
                  {templateApplied
                    ? '✓ PR template applied'
                    : primaryTemplate
                      ? '○ PR template exceeds scan limit'
                      : '○ no PR template'}
                </span>
                {context.policies.pullRequestDraft ? <span className="badge-ok normal-case">✓ opens as draft</span> : null}
                {context.policies.conventionalPrTitle ? <span className="badge-ok normal-case">✓ conventional PR title</span> : null}
                {context.policies.agentProvenance ? <span className="badge-ok normal-case">✓ repo provenance kept</span> : null}
              </div>
              <p className="dim mt-2 text-xs">
                A bounded rules excerpt is injected automatically into code-changing runs. The agent receives the skill
                catalogue and loads relevant skills from this ref. Scanned {timeAgo(context.scannedAt)}.
              </p>
            </div>

            {context.truncated ? (
              <div className="banner-info mb-0 text-xs">
                The repository exceeded a scan limit. Detected resources are still applied; oversized or extra files are
                left out instead of growing every agent prompt without bound.
              </div>
            ) : null}

            <Tabs<AgentContextTab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'rules', label: 'Rules', count: rules.length },
                { value: 'skills', label: 'Skills', count: skills.length },
                { value: 'template', label: 'PR template', count: templates.length },
              ]}
            />

            {shown.length > 0 ? (
              <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                {shown.map((file) => <AgentContextResource key={file.path} file={file} />)}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                {tab === 'rules'
                  ? 'No AGENTS.md, tool instructions or contributing guide was detected.'
                  : tab === 'skills'
                    ? 'No repository-local SKILL.md files were detected.'
                    : 'No pull request template was detected in a conventional location.'}
              </div>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function AgentContextResource({ file }: { file: RepoAgentContextFile }): JSX.Element {
  return (
    <details className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 dark:hover:bg-zinc-950/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{file.name}</span>
            {file.primary && file.content.trim() ? <span className="badge-ok normal-case">applied</span> : null}
            {file.kind === 'instructions' ? (
              <span className="badge normal-case">{file.content.trim() ? 'auto-injected' : 'detected only'}</span>
            ) : null}
            {file.kind === 'skill' ? <span className="badge normal-case">available to agent</span> : null}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">{file.path}</span>
          {file.description ? <span className="dim mt-1 block text-xs">{file.description}</span> : null}
        </span>
        <span className="dim shrink-0 text-xs">{file.truncated ? 'partial' : `${Math.max(1, Math.ceil(file.size / 1024))} KB`}</span>
      </summary>
      <pre className="max-h-80 overflow-auto border-t border-zinc-200 bg-zinc-950 p-4 text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200 dark:border-zinc-800">
        {file.content || 'Content was not included because the file exceeded the safe scan limit.'}
      </pre>
    </details>
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
  const from = workspaces.find((w) => w.id === repo.workspaceId);
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.moveRepo(repo.fullName, repo.workspaceId, target);
      onDone();
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Transfer ${repo.fullName}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Target workspace">
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((w) => (
              <option key={w.id} value={w.id}>
                {workspaceLabel(w, workspaces)}
              </option>
            ))}
          </select>
        </Field>
        <p className="dim text-[13px]">
          The repo leaves <strong>{from ? workspaceLabel(from, workspaces) : null}</strong> and joins the target.
          Its shared GitHub cache and local clone stay intact.
        </p>
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !target}>
            {busy ? 'Transferring…' : 'Transfer'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/** `owner/name` from anything a user pastes: shorthand, an https URL, or git@ SSH. */
function parseRepoInput(raw: string): string | null {
  const s = raw.trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(s) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(s) ??
    /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

function AddRepoModal({
  workspace,
  existing,
  onClose,
  onDone,
}: {
  workspace: WorkspaceRecord;
  existing: readonly RepoRecord[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { githubHost } = useAuth();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RepoCandidate[] | null>(null);
  const [browseFailed, setBrowseFailed] = useState(false);

  const parsed = parseRepoInput(input);
  const connected = new Set(existing.map((r) => r.fullName));

  useEffect(() => {
    let alive = true;
    api
      .repoCandidates(workspace.id)
      .then((r) => alive && setCandidates(r.candidates))
      .catch(() => alive && (setBrowseFailed(true), setCandidates([])));
    return () => {
      alive = false;
    };
  }, [workspace.id]);

  const connect = async (fullName: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.addRepo(fullName, workspace.id);
      onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!parsed) {
      setError('Enter owner/name or a GitHub repository URL.');
      return;
    }
    await connect(parsed);
  };

  // The one input does both: paste a URL/shorthand, or type to filter the list.
  const filter = (parsed ?? input).trim().toLowerCase();
  const matches = (candidates ?? []).filter((c) => !filter || c.fullName.toLowerCase().includes(filter));

  return (
    <Modal title={`Connect a repository — ${workspace.name}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Repository">
          <input
            className="input"
            placeholder={`owner/name or https://${githubHost}/owner/name`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
          />
        </Field>
        {parsed && parsed !== input.trim() ? (
          <p className="dim -mt-1.5 text-xs">
            Connects <strong>{parsed}</strong>
          </p>
        ) : null}

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="dim border-b border-zinc-200 px-3 py-2 text-[10px] font-medium tracking-widest uppercase dark:border-zinc-800">
            From your GitHub
          </div>
          {candidates === null ? (
            <div className="dim flex items-center gap-2 px-3 py-3 text-[13px]">
              <Spinner /> Loading your repositories…
            </div>
          ) : matches.length === 0 ? (
            <p className="dim px-3 py-3 text-[13px]">
              {browseFailed || candidates.length === 0 ? (
                <>
                  Nothing to browse —{' '}
                  <a className="linkish" href="#/github">
                    connect a GitHub account
                  </a>{' '}
                  with access, or type the repository above.
                </>
              ) : (
                'No match in your repositories — type the exact owner/name above.'
              )}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto p-1.5" aria-label="Your repositories">
              {matches.slice(0, 50).map((c) => {
                const done = connected.has(c.fullName);
                return (
                  <li key={c.fullName}>
                    <button
                      type="button"
                      disabled={busy || done}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-zinc-800"
                      title={done ? 'Already connected to this workspace' : `Connect ${c.fullName}`}
                      onClick={() => void connect(c.fullName)}
                    >
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-[13px] font-medium">{c.fullName}</span>
                        {c.description ? <span className="dim block truncate text-xs">{c.description}</span> : null}
                      </span>
                      {c.private ? <span className="badge shrink-0">private</span> : null}
                      <span className="dim shrink-0 text-xs">
                        {done ? 'connected' : c.pushedAt ? timeAgo(c.pushedAt) : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="dim text-[13px]">
          The repo connects into <strong>{workspace.name}</strong> — the active workspace. The same repository may
          also be connected to other workspaces.
        </p>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !parsed}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </FormActions>
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
      await workspaceApi.updateWorkspace(workspace.id, { name: name.trim() });
      setNote('Saved.');
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const { confirmDanger, confirmElement } = useConfirm();

  const setVisibility = async (visibility: WorkspaceVisibility): Promise<void> => {
    if (visibility === workspace.visibility) return;
    const ok = await confirmDanger({
      title: visibility === 'public' ? 'Make this workspace public?' : 'Make this workspace private?',
      message:
        visibility === 'public'
          ? 'Every user will be able to see and work in this workspace, including all its repositories, issues, and pull requests.'
          : 'Only you and the people you invite will be able to see this workspace. Everyone else loses access immediately.',
      confirmLabel: visibility === 'public' ? 'Make public' : 'Make private',
    });
    if (!ok) return;
    setError(null);
    try {
      await workspaceApi.updateWorkspace(workspace.id, { visibility });
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete workspace ${workspace.name}`,
      message: `"${workspace.name}" is removed permanently, together with its pipelines and step library.`,
    });
    if (!ok) return;
    setError(null);
    try {
      await workspaceApi.deleteWorkspace(workspace.id);
      onDeleted();
    } catch (err) {
      setError(String(err));
    }
  };

  const deleteBlocked = repoCount > 0 ? 'Move or remove its repos first' : !canDelete ? 'The last workspace cannot be deleted' : null;

  return (
    <Modal title={`Workspace settings — ${workspace.name}`} onClose={onClose}>
      <form className="flex items-end gap-2" onSubmit={(e) => void rename(e)}>
        <Field label="Name" className="min-w-0 flex-1">
          <input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button className="btn py-2" type="submit" disabled={busy || name.trim().length < 2 || name.trim() === workspace.name}>
          {busy ? 'Saving…' : 'Rename'}
        </button>
      </form>
      {note ? <p className="mt-2 text-[13px] text-emerald-600 dark:text-emerald-400">{note}</p> : null}

      <fieldset className="mt-4">
        <legend className="text-[13px] font-medium">Visibility</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(['public', 'private'] as const).map((v) => {
            const selected = workspace.visibility === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={selected}
                onClick={() => void setVisibility(v)}
                className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ${
                  selected
                    ? 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-800/60'
                    : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                }`}
              >
                {v === 'private' ? (
                  <LockIcon className="mt-0.5 size-4" />
                ) : (
                  <svg viewBox="0 0 16 16" fill="none" className="mt-0.5 size-4 shrink-0" aria-hidden>
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M2 8h12M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14M8 2C6.2 3.6 5.2 5.8 5.2 8S6.2 12.4 8 14" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                )}
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium capitalize">{v}</span>
                  <span className="dim block text-xs">
                    {v === 'public' ? 'Shared with everyone' : 'Just you and people you invite'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {workspace.visibility === 'private' ? <MembersSection workspace={workspace} /> : null}

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
      <ErrorBar error={error} className="mt-2" />
      {confirmElement}
    </Modal>
  );
}

/** Invite/remove members of a private workspace (owner + admins). */
function MembersSection({ workspace }: { workspace: WorkspaceRecord }): JSX.Element {
  const { members, error, setError, add, remove } = useWorkspaceMembers(workspace.id);
  const count = members?.length ?? 0;

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between px-3.5 pt-3">
        <div>
          <div className="text-[13px] font-medium">Members</div>
          <p className="dim mt-0.5 text-xs">People who can see and work in this private workspace.</p>
        </div>
        {members ? <span className="dim text-xs tabular-nums">{count}</span> : null}
      </div>

      <UserPicker workspaceId={workspace.id} onAdd={add} onError={setError} />

      <ul className="flex flex-col px-1.5 pb-1.5">
        {members?.map((m) => (
          <li key={m.username} className="group/mem flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <Avatar name={m.displayName} size="sm" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">{m.displayName}</span>
              <span className="dim block truncate text-xs">@{m.username}</span>
            </span>
            {m.role === 'owner' ? (
              <span className="badge shrink-0">owner</span>
            ) : (
              <IconButton
                label={`Remove ${m.displayName}`}
                danger
                className="opacity-0 transition-opacity group-hover/mem:opacity-100 focus-visible:opacity-100"
                onClick={() => void remove(m.username)}
              >
                <CloseIcon />
              </IconButton>
            )}
          </li>
        ))}
        {members?.length === 0 ? (
          <li className="dim px-2 py-3 text-center text-sm">No members yet — search above to add people.</li>
        ) : null}
      </ul>
      <ErrorBar error={error} className="mx-3.5 mb-3" />
    </div>
  );
}

/**
 * Searchable people picker: type to search users (workspace-scoped candidate
 * feed, already-members excluded), arrow/enter to add. Adds on select and
 * keeps the box open so several can be added in a row.
 */
function UserPicker({
  workspaceId,
  onAdd,
  onError,
}: {
  workspaceId: string;
  onAdd: (username: string) => Promise<void>;
  onError: (e: string | null) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<WorkspaceMemberCandidate[]>([]);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(query, 200);

  // Fetch candidates whenever the (debounced) query changes and the box is open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    workspaceApi
      .workspaceMemberCandidates(workspaceId, debounced.trim())
      .then((r) => alive && (setResults(r.candidates), setActive(0)))
      .catch(() => alive && setResults([]));
    return () => {
      alive = false;
    };
  }, [workspaceId, debounced, open]);

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pick = async (username: string): Promise<void> => {
    setAdding(username);
    onError(null);
    try {
      await onAdd(username);
      // Drop the just-added user from the list; keep the box open for the next.
      setResults((prev) => prev.filter((c) => c.username !== username));
      setQuery('');
      setActive(0);
    } catch (err) {
      onError(String(err));
    } finally {
      setAdding(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[active];
      if (c) void pick(c.username);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative px-3.5 py-3">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 focus-within:border-zinc-400 dark:border-zinc-700 dark:focus-within:border-zinc-500">
        <svg viewBox="0 0 16 16" fill="none" className="dim size-4 shrink-0" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <input
          className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-zinc-400"
          placeholder="Search people to add…"
          aria-label="Search people to add"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>

      {open ? (
        <div className="absolute inset-x-3.5 top-full z-20 mt-1 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {results.length === 0 ? (
            <div className="dim px-3 py-3 text-center text-[13px]">
              {debounced.trim() ? 'No matching people.' : 'Everyone already has access.'}
            </div>
          ) : (
            <ul className="max-h-56 overflow-y-auto p-1" role="listbox">
              {results.map((c, i) => (
                <li key={c.username}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    disabled={adding !== null}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${
                      i === active ? 'bg-zinc-100 dark:bg-zinc-800' : ''
                    }`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void pick(c.username)}
                  >
                    <Avatar name={c.displayName} size="sm" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm font-medium">{c.displayName}</span>
                      <span className="dim block truncate text-xs">@{c.username}</span>
                    </span>
                    {adding === c.username ? (
                      <Spinner />
                    ) : (
                      <span className={`dim shrink-0 text-xs ${i === active ? 'opacity-100' : 'opacity-0'}`}>Add</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
