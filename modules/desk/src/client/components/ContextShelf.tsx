import { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  BranchIcon,
  CloseIcon,
  ContextPanelIcon,
  ErrorBar,
  ExternalLinkIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
  StatusDot,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import type {
  ChecksSummary,
  CommentRecord,
  IssueListRecord,
  IssueRecord,
  PrListRecord,
  PrRecord,
} from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';
import { useAuth } from '@companion/module-core/client';
import { LanePicker } from '@companion/module-operate/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { deskApi } from '../api.js';
import { githubAvatarUrl, githubContextUrl, githubRepoUrl, githubUserUrl } from '../github.js';
import { PrHealth } from './PrHealth.js';

interface ContextShelfProps {
  readonly view: DeskMissionView | null;
  readonly onUpdated: (view: DeskMissionView) => Promise<void>;
}

export function ContextShelf({ view, onUpdated }: ContextShelfProps): React.JSX.Element {
  const { githubHost } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [prs, setPrs] = useState<readonly PrListRecord[]>([]);
  const [issues, setIssues] = useState<readonly IssueListRecord[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPickerOpen(false);
    setPrs([]);
    setIssues([]);
    setLoadedScope(null);
    setError(null);
  }, [view?.mission.id]);

  useEffect(() => {
    if (!view || (!pickerOpen && view.mission.contexts.length === 0)) return;
    const scopeKey = `${view.mission.workspaceId}:${view.mission.repo ?? '*'}`;
    if (loadedScope === scopeKey) return;
    let alive = true;
    setLoading(true);
    setError(null);
    const page = { limit: 60, offset: 0, ...(view.mission.repo ? { repo: view.mission.repo } : {}) };
    void Promise.all([
      codeApi.workspacePrs(view.mission.workspaceId, 'open', page),
      codeApi.workspaceIssues(view.mission.workspaceId, 'open', page),
    ]).then(([prFeed, issueFeed]) => {
      if (!alive) return;
      setPrs(prFeed.prs);
      setIssues(issueFeed.issues);
      setLoadedScope(scopeKey);
    }).catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [loadedScope, pickerOpen, view]);

  const attachedKeys = useMemo(
    () => new Set(view?.mission.contexts.map(contextKey) ?? []),
    [view?.mission.contexts],
  );

  const changeContext = async (context: DeskContextRef, attach: boolean): Promise<void> => {
    if (!view) return;
    const key = contextKey(context);
    setBusyKey(key);
    setError(null);
    try {
      const contexts = attach
        ? [...view.mission.contexts, context]
        : view.mission.contexts.filter((item) => contextKey(item) !== key);
      await onUpdated(await deskApi.updateMission(view.mission.id, { contexts }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const primary = view?.mission.contexts[0] ?? null;
  const summary = primary?.kind === 'pull-request'
    ? prs.find((pr) => pr.repo === primary.repo && pr.number === primary.number)
    : primary ? issues.find((issue) => issue.repo === primary.repo && issue.number === primary.number) : undefined;

  return (
    <aside
      className={`relative flex shrink-0 flex-col overflow-hidden border-l bg-white transition-[width,border-color] duration-300 ease-out dark:bg-zinc-950 ${
        collapsed
          ? 'w-12 border-zinc-200 dark:border-zinc-800'
          : 'w-[20rem] border-zinc-200 xl:w-[23rem] dark:border-zinc-800'
      }`}
      aria-label={collapsed ? 'Collapsed context shelf' : 'Context shelf'}
    >
      {collapsed ? (
        <ContextToolbar
          actions={[
            {
              key: 'open',
              label: 'Show context',
              icon: <ContextPanelIcon />,
              onClick: () => setCollapsed(false),
            },
            {
              key: 'attach',
              label: 'Attach context',
              icon: <PlusIcon />,
              onClick: () => {
                setPickerOpen(true);
                setCollapsed(false);
              },
              disabled: !view,
            },
          ]}
        />
      ) : null}

      <div
        className={`flex min-h-0 w-[20rem] flex-1 flex-col overflow-hidden transition-opacity duration-150 xl:w-[23rem] ${
          collapsed ? 'pointer-events-none opacity-0' : 'opacity-100 delay-150'
        }`}
        aria-hidden={collapsed}
        inert={collapsed}
      >
        <div className="flex shrink-0 items-center gap-2 px-5 pt-5">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">Context</h2>
          <button type="button" className="dim flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" onClick={() => setPickerOpen((open) => !open)} disabled={!view} aria-label="Attach context">
            {pickerOpen ? <CloseIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
          </button>
          <button type="button" className="dim flex size-7 cursor-pointer items-center justify-center rounded-md border border-zinc-200 hover:text-zinc-900 dark:border-zinc-800 dark:hover:text-zinc-100" onClick={() => setCollapsed(true)} aria-label="Collapse context"><ContextPanelIcon className="size-3.5" /></button>
        </div>

        <ErrorBar error={error} className="mx-5 mt-3" />

        {pickerOpen ? (
          <ContextPicker
            prs={prs}
            issues={issues}
            loading={loading}
            attached={attachedKeys}
            busyKey={busyKey}
            onToggle={(context) => void changeContext(context, !attachedKeys.has(contextKey(context)))}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5">
            {primary ? (
              <PrimaryContext key={contextKey(primary)} context={primary} summary={summary} githubHost={githubHost} />
            ) : (
              <button
                type="button"
                className="dim mt-1 w-full cursor-pointer rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-xs leading-relaxed hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
                disabled={!view}
                onClick={() => setPickerOpen(true)}
              >
                Attach a pull request or issue to give this mission visible GitHub context.
              </button>
            )}

            {view && view.mission.contexts.length > 1 ? (
              <section className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800" aria-labelledby="additional-context">
                <h3 id="additional-context" className="dim text-[10px] font-medium tracking-wide uppercase">Also attached</h3>
                <div className="mt-2 space-y-1">
                  {view.mission.contexts.slice(1).map((context) => (
                    <div key={contextKey(context)} className="group flex items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900">
                      <StatusDot tone={context.kind === 'pull-request' ? 'green' : 'zinc'} size="sm" />
                      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                        <a href={githubContextUrl(githubHost, context.repo, context.kind, context.number)} target="_blank" rel="noreferrer" className="shrink-0 hover:underline">{context.kind === 'pull-request' ? 'PR' : 'Issue'} #{context.number}</a>
                        <span className="dim">·</span>
                        <a href={githubRepoUrl(githubHost, context.repo)} target="_blank" rel="noreferrer" className="dim truncate hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">{context.repo}</a>
                      </span>
                      <button type="button" className="dim cursor-pointer opacity-0 hover:text-red-600 group-hover:opacity-100 dark:hover:text-red-400" onClick={() => void changeContext(context, false)} aria-label="Remove context"><CloseIcon className="size-3" /></button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}

        <div className="mx-5 mt-5 mb-5 shrink-0 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div className="dim truncate text-[11px]">{view?.mission.repo ?? 'Whole workspace'}</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="dim min-w-0 flex-1 truncate text-[11px]">{view?.run?.harness.label ?? view?.mission.harness ?? 'Auto'} · background</span>
            <LanePicker rail />
          </div>
        </div>
      </div>
    </aside>
  );
}

interface ContextToolbarAction {
  readonly key: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

/** Collapsed rail actions live in one extensible toolbar instead of floating controls. */
function ContextToolbar({ actions }: { readonly actions: readonly ContextToolbarAction[] }): React.JSX.Element {
  return (
    <div className="absolute inset-y-0 left-0 flex w-12 flex-col items-center gap-1 bg-[#fcfcfb] px-2 py-3 dark:bg-zinc-950" role="toolbar" aria-label="Context tools">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className="dim flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent transition-colors hover:border-zinc-200 hover:bg-white hover:text-zinc-900 disabled:cursor-default disabled:opacity-35 dark:hover:border-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          onClick={action.onClick}
          disabled={action.disabled}
          aria-label={action.label}
          title={action.label}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}

function ContextPicker({
  prs,
  issues,
  loading,
  attached,
  busyKey,
  onToggle,
}: {
  readonly prs: readonly PrListRecord[];
  readonly issues: readonly IssueListRecord[];
  readonly loading: boolean;
  readonly attached: ReadonlySet<string>;
  readonly busyKey: string | null;
  readonly onToggle: (context: DeskContextRef) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (item: PrListRecord | IssueListRecord): boolean =>
    !needle || `#${item.number} ${item.title} ${item.repo}`.toLowerCase().includes(needle);
  const shownPrs = prs.filter(matches);
  const shownIssues = issues.filter(matches);

  return (
    <section className="mx-5 mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800" aria-label="Available context">
      <div className="shrink-0 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <div className="text-xs font-semibold">Attach context</div>
        <div className="dim mt-0.5 text-[10px]">Open items in this mission’s scope</div>
        <label className="relative mt-2.5 block">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            className="input input-sm w-full pl-8 text-xs"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search PRs and issues"
            aria-label="Search pull requests and issues"
          />
        </label>
      </div>
      {loading ? <div className="flex items-center gap-2 px-3 py-4 text-xs"><Spinner /> Loading GitHub context…</div> : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {shownPrs.length > 0 ? <PickerGroup title="Pull requests">
            {shownPrs.map((pr) => {
              const context: DeskContextRef = { kind: 'pull-request', repo: pr.repo, number: pr.number };
              return <PickerRow key={contextKey(context)} context={context} title={pr.title} attached={attached.has(contextKey(context))} busy={busyKey === contextKey(context)} onClick={() => onToggle(context)} />;
            })}
          </PickerGroup> : null}
          {shownIssues.length > 0 ? <PickerGroup title="Issues">
            {shownIssues.map((issue) => {
              const context: DeskContextRef = { kind: 'issue', repo: issue.repo, number: issue.number };
              return <PickerRow key={contextKey(context)} context={context} title={issue.title} attached={attached.has(contextKey(context))} busy={busyKey === contextKey(context)} onClick={() => onToggle(context)} />;
            })}
          </PickerGroup> : null}
          {shownPrs.length === 0 && shownIssues.length === 0 ? <p className="dim px-3 py-8 text-center text-xs">{needle ? 'No matching pull requests or issues.' : 'No open items in this scope.'}</p> : null}
        </div>
      )}
    </section>
  );
}

function PickerGroup({ title, children }: { readonly title: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800">
      <div className="dim bg-zinc-50 px-3 py-1.5 text-[9px] font-medium tracking-wide uppercase dark:bg-zinc-900">{title}</div>
      {children}
    </div>
  );
}

function PickerRow({ context, title, attached, busy, onClick }: { readonly context: DeskContextRef; readonly title: string; readonly attached: boolean; readonly busy: boolean; readonly onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="flex w-full cursor-pointer items-start gap-2 border-t border-zinc-100 px-3 py-2 text-left first:border-t-0 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-900 dark:hover:bg-zinc-900" disabled={busy} onClick={onClick}>
      <StatusDot tone={context.kind === 'pull-request' ? 'green' : 'zinc'} size="sm" className="mt-1" />
      <span className="min-w-0 flex-1"><span className="line-clamp-2 text-[11px] font-medium">#{context.number} {title}</span><span className="dim mt-0.5 block truncate text-[9px]">{context.repo}</span></span>
      <span className={attached ? 'text-[9px] text-emerald-600 dark:text-emerald-400' : 'dim text-[9px]'}>{busy ? '…' : attached ? 'Attached' : 'Add'}</span>
    </button>
  );
}

function PrimaryContext({ context, summary, githubHost }: { readonly context: DeskContextRef; readonly summary: PrListRecord | IssueListRecord | undefined; readonly githubHost: string }): React.JSX.Element {
  const [detail, setDetail] = useState<{
    readonly record: PrRecord | IssueRecord;
    readonly checks: ChecksSummary | null;
    readonly comments: readonly CommentRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (context.kind === 'pull-request') {
          const [record, checkFeed, commentFeed] = await Promise.all([
            codeApi.getPr(context.repo, context.number),
            codeApi.prChecks(context.repo, context.number).catch(() => ({ checks: null })),
            codeApi.prComments(context.repo, context.number).catch(() => ({ comments: [] })),
          ]);
          if (alive) setDetail({ record: record.pr, checks: checkFeed.checks, comments: commentFeed.comments });
        } else {
          const [record, commentFeed] = await Promise.all([
            codeApi.getIssue(context.repo, context.number),
            codeApi.issueComments(context.repo, context.number).catch(() => ({ comments: [] })),
          ]);
          if (alive) setDetail({ record: record.issue, checks: null, comments: commentFeed.comments });
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [context.kind, context.number, context.repo]);

  const record = detail?.record ?? summary ?? null;
  const checks = detail?.checks ?? ('checks' in (record ?? {}) ? (record as PrListRecord).checks : null);
  const people = record ? [record.author, ...record.assignees].filter((name, index, all) => all.indexOf(name) === index) : [];

  return (
    <section aria-label="Primary context">
      <div className="flex items-start gap-3">
        {context.kind === 'pull-request' ? <BranchIcon className="mt-0.5 size-4 text-amber-700 dark:text-amber-400" /> : <span className="mt-0.5 text-xs font-semibold text-violet-600">#</span>}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            <span>{context.kind === 'pull-request' ? 'PR' : 'Issue'} </span>
            <a href={record?.url ?? githubContextUrl(githubHost, context.repo, context.kind, context.number)} target="_blank" rel="noreferrer" className="underline decoration-zinc-300 underline-offset-2 hover:decoration-current dark:decoration-zinc-700">#{context.number}</a>
            {record ? <span> · {record.title}</span> : null}
          </div>
          <a href={githubRepoUrl(githubHost, context.repo)} target="_blank" rel="noreferrer" className="dim mt-1 block truncate text-[11px] hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">{context.repo}</a>
        </div>
      </div>

      {loading && !record ? <div className="mt-5 flex items-center gap-2 text-xs"><Spinner /> Loading context…</div> : null}
      <ErrorBar error={error} className="mt-3" />
      {record ? (
        <>
          <dl className="mt-5 space-y-3 border-t border-zinc-200 pt-4 text-xs dark:border-zinc-800">
            <ShelfRow label="Status"><span className="flex items-center gap-2 capitalize"><StatusDot tone={record.state === 'open' ? 'green' : 'zinc'} size="sm" />{record.state}</span></ShelfRow>
            {checks ? <ShelfRow label="Checks"><span>{checks.passed} passed · <span className={checks.failed ? 'text-red-600 dark:text-red-400' : ''}>{checks.failed} failing</span></span></ShelfRow> : null}
            <ShelfRow label="People">
              <span className="flex -space-x-1.5">
                {people.slice(0, 3).map((name) => (
                  <a key={name} href={githubUserUrl(githubHost, name)} target="_blank" rel="noreferrer" aria-label={`Open ${name} on GitHub`} title={name}>
                    <Avatar name={name} src={githubAvatarUrl(githubHost, name)} size="xs" className="!rounded-full ring-2 ring-white dark:ring-zinc-950" />
                  </a>
                ))}
                {people.length > 3 ? <span className="flex size-5 items-center justify-center rounded-full border border-zinc-200 bg-white text-[8px] ring-2 ring-white dark:border-zinc-700 dark:bg-zinc-900 dark:ring-zinc-950">+{people.length - 3}</span> : null}
              </span>
            </ShelfRow>
          </dl>

          {context.kind === 'pull-request' ? <PrHealth repo={context.repo} number={context.number} /> : null}

          <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <h3 className="dim text-[10px] font-medium tracking-wide uppercase">Recent comments</h3>
            {detail?.comments.length ? (
              <div className="mt-3 space-y-4">
                {detail.comments.slice(-3).reverse().map((comment, index) => (
                  <Comment key={`${comment.author}:${comment.createdAt}:${index}`} comment={comment} githubHost={githubHost} />
                ))}
              </div>
            ) : <p className="dim mt-3 text-xs">No comments yet.</p>}
          </div>

          <a href={record.url} target="_blank" rel="noreferrer" className="dim mt-5 flex items-center gap-2 border-t border-zinc-200 pt-4 text-xs hover:text-zinc-900 dark:border-zinc-800 dark:hover:text-zinc-100">
            <ExternalLinkIcon className="size-3.5" /> Open on GitHub
          </a>
        </>
      ) : null}
    </section>
  );
}

function ShelfRow({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-3"><dt className="dim flex-1">{label}</dt><dd>{children}</dd></div>;
}

function Comment({ comment, githubHost }: { readonly comment: CommentRecord; readonly githubHost: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <a href={githubUserUrl(githubHost, comment.author)} target="_blank" rel="noreferrer" aria-label={`Open ${comment.author} on GitHub`}>
        <Avatar name={comment.author} src={githubAvatarUrl(githubHost, comment.author)} size="xs" className="!rounded-full" />
      </a>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[10px]"><a href={githubUserUrl(githubHost, comment.author)} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{comment.author}</a><a href={comment.url} target="_blank" rel="noreferrer" className="dim hover:underline">{timeAgo(comment.createdAt)}</a></div>
        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed">{plainText(comment.body)}</p>
      </div>
    </div>
  );
}

function plainText(markdown: string): string {
  return markdown.replace(/[`*_>#\[\]()]/g, '').replace(/\s+/g, ' ').trim();
}

function contextKey(context: DeskContextRef): string {
  return `${context.kind}:${context.repo}#${context.number}`;
}
