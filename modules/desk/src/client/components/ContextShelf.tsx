import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  CloseIcon,
  ErrorBar,
  Markdown,
  PlusIcon,
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
import { LanePicker, useLane } from '@companion/module-operate/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { deskApi } from '../api.js';
import { missionStatus } from '../status.js';

interface ContextShelfProps {
  readonly view: DeskMissionView | null;
  readonly onUpdated: (view: DeskMissionView) => Promise<void>;
}

export function ContextShelf({ view, onUpdated }: ContextShelfProps): React.JSX.Element {
  const lane = useLane();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [prs, setPrs] = useState<readonly PrListRecord[]>([]);
  const [issues, setIssues] = useState<readonly IssueListRecord[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = view ? missionStatus(view) : null;

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
      const updated = await deskApi.updateMission(view.mission.id, { contexts });
      await onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <aside className="flex w-[23rem] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/45" aria-label="Context shelf">
      <div className="flex h-14 shrink-0 items-center border-b border-zinc-200 px-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Context</div>
          <div className="dim text-[11px]">What this mission can see at a glance</div>
        </div>
        <button
          type="button"
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-zinc-200 disabled:cursor-default disabled:opacity-40 dark:hover:bg-zinc-800"
          aria-label="Attach pull request or issue"
          title="Attach pull request or issue"
          disabled={!view}
          onClick={() => setPickerOpen((open) => !open)}
        >
          {pickerOpen ? <CloseIcon className="size-4" /> : <PlusIcon className="size-4" />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <section className="rounded-2xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900" aria-labelledby="desk-environment">
          <div className="flex items-center gap-2">
            <h2 id="desk-environment" className="dim flex-1 text-[11px] font-medium tracking-wide uppercase">Environment</h2>
            {status ? <StatusDot tone={status.tone} pulse={status.pulse} title={status.label} /> : null}
          </div>
          <dl className="mt-3 space-y-2.5 text-xs">
            <EnvironmentRow label="Workspace" value={view?.mission.workspaceId ?? 'No mission'} />
            <EnvironmentRow label="Repository" value={view?.mission.repo ?? 'Whole workspace'} />
            <EnvironmentRow
              label="Runtime"
              value={view?.run?.harness.label ?? view?.mission.harness ?? lane.label}
              hint={view ? 'Captured by this mission' : 'For the next mission'}
            />
            <EnvironmentRow label="Status" value={status?.label ?? 'Not started'} />
          </dl>
          <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <LanePicker />
          </div>
        </section>

        <ErrorBar error={error} className="mt-3" />

        {pickerOpen ? (
          <section className="anim-in mt-3 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900" aria-label="Available context">
            <div className="border-b border-zinc-200 px-3.5 py-3 dark:border-zinc-800">
              <h2 className="text-xs font-semibold">Attach context</h2>
              <p className="dim mt-0.5 text-[11px]">Open items from this mission's scope</p>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 px-3.5 py-4 text-xs"><Spinner /> Loading GitHub context…</div>
            ) : (
              <div className="max-h-[24rem] overflow-y-auto">
                <PickerGroup title="Pull requests" count={prs.length}>
                  {prs.map((pr) => {
                    const context: DeskContextRef = { kind: 'pull-request', repo: pr.repo, number: pr.number };
                    return (
                      <PickerRow
                        key={`pr:${pr.repo}#${pr.number}`}
                        title={`#${pr.number} ${pr.title}`}
                        repo={pr.repo}
                        tone={checkTone(pr)}
                        attached={attachedKeys.has(contextKey(context))}
                        busy={busyKey === contextKey(context)}
                        onClick={() => void changeContext(context, !attachedKeys.has(contextKey(context)))}
                      />
                    );
                  })}
                </PickerGroup>
                <PickerGroup title="Issues" count={issues.length}>
                  {issues.map((issue) => {
                    const context: DeskContextRef = { kind: 'issue', repo: issue.repo, number: issue.number };
                    return (
                      <PickerRow
                        key={`issue:${issue.repo}#${issue.number}`}
                        title={`#${issue.number} ${issue.title}`}
                        repo={issue.repo}
                        tone={issue.triage === 'running' ? 'blue' : 'zinc'}
                        attached={attachedKeys.has(contextKey(context))}
                        busy={busyKey === contextKey(context)}
                        onClick={() => void changeContext(context, !attachedKeys.has(contextKey(context)))}
                      />
                    );
                  })}
                </PickerGroup>
                {prs.length === 0 && issues.length === 0 ? (
                  <p className="dim px-3.5 py-5 text-center text-xs">No open pull requests or issues in this scope.</p>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        <section className="mt-3" aria-labelledby="attached-context">
          <div className="mb-2 flex items-center gap-2 px-1">
            <h2 id="attached-context" className="dim flex-1 text-[11px] font-medium tracking-wide uppercase">Attached</h2>
            <span className="dim text-[11px]">{view?.mission.contexts.length ?? 0}</span>
          </div>
          {view?.mission.contexts.length ? (
            <div className="space-y-2">
              {view.mission.contexts.map((context) => (
                <ContextCard
                  key={contextKey(context)}
                  context={context}
                  summary={context.kind === 'pull-request'
                    ? prs.find((pr) => pr.repo === context.repo && pr.number === context.number)
                    : issues.find((issue) => issue.repo === context.repo && issue.number === context.number)}
                  removing={busyKey === contextKey(context)}
                  onRemove={() => void changeContext(context, false)}
                />
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="dim w-full cursor-pointer rounded-2xl border border-dashed border-zinc-300 px-4 py-7 text-center text-xs transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
              disabled={!view}
              onClick={() => setPickerOpen(true)}
            >
              Attach PRs and issues so the agent and you share the same visible context.
            </button>
          )}
        </section>
      </div>
    </aside>
  );
}

function EnvironmentRow({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint?: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[5.2rem_minmax(0,1fr)] items-baseline gap-2">
      <dt className="dim">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium" title={value}>{value}</dd>
      {hint ? <dd className="dim col-start-2 -mt-1 text-right text-[10px]">{hint}</dd> : null}
    </div>
  );
}

function PickerGroup({ title, count, children }: { readonly title: string; readonly count: number; readonly children: React.ReactNode }): React.JSX.Element | null {
  if (count === 0) return null;
  return (
    <div className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800">
      <div className="dim flex items-center gap-2 bg-zinc-50 px-3.5 py-1.5 text-[10px] tracking-wide uppercase dark:bg-zinc-950/50">
        <span className="flex-1">{title}</span><span>{count}</span>
      </div>
      {children}
    </div>
  );
}

function PickerRow({ title, repo, tone, attached, busy, onClick }: {
  readonly title: string;
  readonly repo: string;
  readonly tone: 'blue' | 'amber' | 'red' | 'green' | 'zinc';
  readonly attached: boolean;
  readonly busy: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-start gap-2 border-t border-zinc-100 px-3.5 py-2.5 text-left transition-colors first:border-t-0 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/60"
      onClick={onClick}
      disabled={busy}
    >
      <StatusDot tone={tone} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-xs font-medium leading-snug">{title}</span>
        <span className="dim mt-0.5 block truncate text-[10px]">{repo}</span>
      </span>
      <span className={attached ? 'badge-ok' : 'badge'}>{busy ? '…' : attached ? 'Attached' : 'Add'}</span>
    </button>
  );
}

function ContextCard({ context, summary, removing, onRemove }: {
  readonly context: DeskContextRef;
  readonly summary: PrListRecord | IssueListRecord | undefined;
  readonly removing: boolean;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{
    readonly record: PrRecord | IssueRecord;
    readonly checks?: ChecksSummary;
    readonly comments: readonly CommentRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || detail || loading) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        if (context.kind === 'pull-request') {
          const result = await codeApi.getPr(context.repo, context.number);
          if (!alive) return;
          setDetail({ record: result.pr, comments: [] });
          setLoading(false);
          setEnriching(true);
          void codeApi.prChecks(context.repo, context.number).then(({ checks }) => {
            if (alive) setDetail((current) => current ? { ...current, checks } : current);
          }).catch(() => undefined);
          void codeApi.prComments(context.repo, context.number).then(({ comments }) => {
            if (alive) setDetail((current) => current ? { ...current, comments } : current);
          }).catch(() => undefined).finally(() => {
            if (alive) setEnriching(false);
          });
        } else {
          const result = await codeApi.getIssue(context.repo, context.number);
          if (!alive) return;
          setDetail({ record: result.issue, comments: [] });
          setLoading(false);
          setEnriching(true);
          void codeApi.issueComments(context.repo, context.number).then(({ comments }) => {
            if (alive) setDetail((current) => current ? { ...current, comments } : current);
          }).catch(() => undefined).finally(() => {
            if (alive) setEnriching(false);
          });
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [context.kind, context.number, context.repo, open]);

  const visible = detail ?? (summary ? { record: summary, comments: [] } : null);

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-2 p-3">
        <StatusDot tone={context.kind === 'pull-request' ? 'green' : 'zinc'} className="mt-1.5" />
        <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <div className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            {context.kind === 'pull-request' ? 'Pull request' : 'Issue'} · #{context.number}
          </div>
          <div className="mt-0.5 truncate text-xs font-medium">{context.repo}</div>
        </button>
        <button type="button" className="dim flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default dark:hover:bg-zinc-800 dark:hover:text-zinc-100" disabled={removing} onClick={onRemove} aria-label="Remove context">
          <CloseIcon className="size-3.5" />
        </button>
        <button type="button" className="dim flex size-6 cursor-pointer items-center justify-center" onClick={() => setOpen((value) => !value)} aria-label={open ? 'Collapse details' : 'Expand details'}>
          <ChevronDown open={open} className="size-3.5" />
        </button>
      </div>
      {open ? (
        <div className="anim-in border-t border-zinc-200 px-3 py-3 dark:border-zinc-800">
          {loading && !visible ? <div className="flex items-center gap-2 text-xs"><Spinner /> Loading details…</div> : null}
          <ErrorBar error={error} />
          {visible ? <ContextDetail detail={visible} enriching={enriching || !detail} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ContextDetail({ detail, enriching }: {
  readonly detail: {
    readonly record: PrRecord | IssueRecord | PrListRecord | IssueListRecord;
    readonly checks?: ChecksSummary;
    readonly comments: readonly CommentRecord[];
  };
  readonly enriching: boolean;
}): React.JSX.Element {
  const body = 'body' in detail.record ? detail.record.body : '';
  return (
    <div className="space-y-3 text-xs">
      <div>
        <h3 className="font-semibold leading-snug">{detail.record.title}</h3>
        <div className="dim mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px]">
          <span>{detail.record.state}</span>
          <span>by {detail.record.author}</span>
          <span>updated {timeAgo(detail.record.updatedAt)}</span>
        </div>
      </div>
      {enriching ? <div className="dim flex items-center gap-1.5 text-[10px]"><Spinner /> Loading checks and comments…</div> : null}
      {detail.checks ? (
        <div className="rounded-lg bg-zinc-50 px-2.5 py-2 dark:bg-zinc-950/70">
          <div className="flex items-center gap-2">
            <StatusDot tone={checksTone(detail.checks.state)} />
            <span className="font-medium">Checks {detail.checks.state}</span>
            <span className="dim ml-auto">{detail.checks.passed}/{detail.checks.total}</span>
          </div>
          {detail.checks.runs.length > 0 ? (
            <div className="mt-2 space-y-1">
              {detail.checks.runs.slice(0, 6).map((run) => (
                <div key={run.name} className="flex items-center gap-2 text-[10px]">
                  <StatusDot tone={run.status !== 'completed' ? 'blue' : run.conclusion === 'success' ? 'green' : 'red'} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{run.name}</span>
                  <span className="dim">{run.conclusion ?? run.status}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {detail.record.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">{detail.record.labels.map((label) => <span className="chip" key={label}>{label}</span>)}</div>
      ) : null}
      {body ? (
        <details>
          <summary className="cursor-pointer font-medium">Description</summary>
          <div className="markdown mt-2 max-h-64 overflow-y-auto text-xs"><Markdown text={body} /></div>
        </details>
      ) : null}
      {detail.comments.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium">Comments ({detail.comments.length})</summary>
          <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
            {detail.comments.slice(-10).map((comment, index) => (
              <div key={`${comment.author}:${comment.createdAt}:${index}`} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="dim mb-1 text-[10px]">{comment.author} · {timeAgo(comment.createdAt)}</div>
                <div className="markdown text-xs"><Markdown text={comment.body} /></div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <a href={detail.record.url} target="_blank" rel="noreferrer" className="linkish inline-block text-xs">Open on GitHub ↗</a>
    </div>
  );
}

function contextKey(context: DeskContextRef): string {
  return `${context.kind}:${context.repo}#${context.number}`;
}

function checkTone(pr: PrListRecord): 'blue' | 'amber' | 'red' | 'green' | 'zinc' {
  return pr.checks ? checksTone(pr.checks.state) : 'zinc';
}

function checksTone(state: 'passing' | 'failing' | 'pending' | 'none' | 'unknown'): 'blue' | 'amber' | 'red' | 'green' | 'zinc' {
  if (state === 'passing') return 'green';
  if (state === 'failing') return 'red';
  if (state === 'pending') return 'blue';
  if (state === 'unknown') return 'amber';
  return 'zinc';
}
