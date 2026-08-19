import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpIcon,
  Avatar,
  BranchIcon,
  ErrorBar,
  ExternalLinkIcon,
  Markdown,
  MicrophoneIcon,
  Spinner,
  StatusDot,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import type {
  ChecksSummary,
  CommentRecord,
  IssueRecord,
  PrRecord,
} from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';
import { useAuth } from '@companion/module-core/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { githubAvatarUrl, githubRepoUrl, githubUserUrl } from '../github.js';
import { missionStatus } from '../status.js';
import { useDictation } from '../hooks/useDictation.js';
import { PrHealth } from './PrHealth.js';

interface ContextPreviewProps {
  readonly context: DeskContextRef;
  readonly missions: readonly DeskMissionView[];
  readonly onBack: () => void;
  readonly onOpenMission: (mission: DeskMissionView) => void;
  readonly onStartMission: (title: string, prompt: string) => Promise<void>;
}

export function ContextPreview({
  context,
  missions,
  onBack,
  onOpenMission,
  onStartMission,
}: ContextPreviewProps): React.JSX.Element {
  const auth = useAuth();
  const [record, setRecord] = useState<PrRecord | IssueRecord | null>(null);
  const [checks, setChecks] = useState<ChecksSummary | null>(null);
  const [comments, setComments] = useState<readonly CommentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const dictation = useDictation(prompt, setPrompt, starting);
  const related = useMemo(
    () => missions.filter((entry) => entry.mission.contexts.some((item) => contextKey(item) === contextKey(context))),
    [context, missions],
  );

  useEffect(() => {
    let alive = true;
    setRecord(null);
    setChecks(null);
    setComments([]);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (context.kind === 'pull-request') {
          const [detail, checkFeed, commentFeed] = await Promise.all([
            codeApi.getPr(context.repo, context.number),
            codeApi.prChecks(context.repo, context.number).catch(() => ({ checks: null })),
            codeApi.prComments(context.repo, context.number).catch(() => ({ comments: [] })),
          ]);
          if (!alive) return;
          setRecord(detail.pr);
          setChecks(checkFeed.checks);
          setComments(commentFeed.comments);
        } else {
          const [detail, commentFeed] = await Promise.all([
            codeApi.getIssue(context.repo, context.number),
            codeApi.issueComments(context.repo, context.number).catch(() => ({ comments: [] })),
          ]);
          if (!alive) return;
          setRecord(detail.issue);
          setComments(commentFeed.comments);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [context.kind, context.number, context.repo]);

  const submit = async (): Promise<void> => {
    const text = prompt.trim();
    if (!record || !text || starting) return;
    dictation.stop();
    setStarting(true);
    setError(null);
    try {
      await onStartMission(`${context.kind === 'pull-request' ? 'PR' : 'Issue'} #${context.number}: ${record.title}`, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  if (loading && !record) {
    return <ContextPreviewSkeleton context={context} onBack={onBack} />;
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#fcfcfb] dark:bg-zinc-950" aria-label="Repository context">
      <div className="mx-auto w-full max-w-[92rem] px-6 py-5">
        <button type="button" className="dim cursor-pointer text-xs hover:text-zinc-900 dark:hover:text-zinc-100" onClick={onBack}>← Overview</button>
        <ErrorBar error={error} className="mt-3" />
        {record ? (
          <>
            <div className="mt-4 flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="dim flex flex-wrap items-center gap-1.5 text-xs">
                  <span>{context.kind === 'pull-request' ? 'Pull request' : 'Issue'}</span>
                  <a href={record.url} target="_blank" rel="noreferrer" className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">#{record.number}</a>
                  <span>·</span>
                  <a href={githubRepoUrl(auth.githubHost, record.repo)} target="_blank" rel="noreferrer" className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">{record.repo}</a>
                </div>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">{record.title}</h1>
                <div className="dim mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <StatusDot tone={record.state === 'open' ? 'green' : 'zinc'} label={record.state} />
                  <span className="capitalize">{record.state}</span>
                  <span>·</span>
                  <span>opened by <a href={githubUserUrl(auth.githubHost, record.author)} target="_blank" rel="noreferrer" className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">{record.author}</a></span>
                  <span>·</span>
                  <span>updated {timeAgo(record.updatedAt)}</span>
                </div>
              </div>
              {related[0] ? (
                <button type="button" className="btn-ghost h-8 text-xs" onClick={() => onOpenMission(related[0]!)}>
                  <StatusDot tone={missionStatus(related[0]).tone} pulse={missionStatus(related[0]).pulse} size="sm" />
                  Open active mission
                </button>
              ) : null}
            </div>

            <div className="mt-6 grid min-h-[34rem] grid-cols-[minmax(0,1fr)_21rem] gap-6">
              <div className="min-w-0">
                <section className="rounded-xl border border-zinc-200 bg-white px-6 py-5 dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="context-description">
                  <h2 id="context-description" className="text-sm font-semibold">Description</h2>
                  {record.body ? (
                    <div className="markdown context-markdown mt-4 max-w-none text-sm leading-relaxed"><Markdown text={record.body} /></div>
                  ) : (
                    <p className="dim mt-3 text-sm">No description provided.</p>
                  )}
                </section>

                {checks ? (
                  <section className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="context-checks">
                    <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
                      <StatusDot tone={checksTone(checks.state)} pulse={checks.state === 'pending'} label={checks.state} />
                      <h2 id="context-checks" className="text-sm font-semibold">Checks</h2>
                      <span className="dim ml-auto text-xs tabular-nums">{checks.passed}/{checks.total} passed</span>
                    </div>
                    {checks.runs.map((run) => (
                      <div key={run.name} className="flex min-h-10 items-center gap-3 border-b border-zinc-100 px-5 py-2 text-xs last:border-b-0 dark:border-zinc-900">
                        <StatusDot tone={run.status !== 'completed' ? 'blue' : run.conclusion === 'success' ? 'green' : 'red'} pulse={run.status !== 'completed'} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{run.name}</span>
                        <span className="dim">{run.conclusion ?? run.status}</span>
                      </div>
                    ))}
                  </section>
                ) : null}

                <form
                  className="mt-4 rounded-xl border border-zinc-300 bg-white p-3 shadow-sm focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500"
                  onSubmit={(event) => { event.preventDefault(); void submit(); }}
                >
                  <textarea
                    rows={3}
                    className="max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-zinc-400"
                    value={prompt}
                    onChange={(event) => {
                      dictation.clearError();
                      setPrompt(event.target.value);
                    }}
                    placeholder="Tell Companion what to do with this context…"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="flex items-center gap-3">
                    <span className={`min-w-0 flex-1 truncate text-[11px] ${dictation.error ? 'text-red-600 dark:text-red-400' : 'dim'}`}>
                      {dictation.error ?? (dictation.listening ? 'Listening… speak naturally' : 'Starts an independent background mission')}
                    </span>
                    <button
                      type="button"
                      className={`flex size-8 cursor-pointer items-center justify-center rounded-lg border transition-colors disabled:cursor-default disabled:opacity-40 ${
                        dictation.listening
                          ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400'
                          : 'border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                      }`}
                      disabled={!dictation.supported || starting}
                      onClick={dictation.toggle}
                      aria-label={dictation.listening ? 'Stop dictation' : 'Start dictation'}
                      aria-pressed={dictation.listening}
                      title={dictation.supported ? (dictation.listening ? 'Stop dictation' : 'Dictate instruction') : 'Voice dictation is not supported by this browser'}
                    >
                      <MicrophoneIcon />
                    </button>
                    <button type="submit" className="btn flex size-8 items-center justify-center p-0" disabled={!prompt.trim() || starting} aria-label="Start mission">
                      {starting ? <Spinner /> : <ArrowUpIcon />}
                    </button>
                  </div>
                </form>
              </div>

              <aside className="h-fit rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950" aria-label="Context shelf">
                <h2 className="text-sm font-semibold">Context</h2>
                <div className="mt-5 flex items-start gap-3">
                  {context.kind === 'pull-request' ? <BranchIcon className="mt-0.5 size-4 text-amber-700 dark:text-amber-400" /> : <span className="mt-0.5 text-xs font-semibold text-violet-600">#</span>}
                  <div className="min-w-0">
                    <div className="font-medium">
                      <span>{context.kind === 'pull-request' ? 'PR' : 'Issue'} </span>
                      <a href={record.url} target="_blank" rel="noreferrer" className="underline decoration-zinc-300 underline-offset-2 hover:decoration-current dark:decoration-zinc-700">#{record.number}</a>
                    </div>
                    <div className="mt-0.5 text-xs">{record.title}</div>
                    <a href={githubRepoUrl(auth.githubHost, record.repo)} target="_blank" rel="noreferrer" className="dim mt-1 block truncate text-[11px] hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">{record.repo}</a>
                  </div>
                </div>
                <dl className="mt-5 space-y-3 border-t border-zinc-200 pt-4 text-xs dark:border-zinc-800">
                  <ShelfRow label="Status"><span className="flex items-center gap-2 capitalize"><StatusDot tone={record.state === 'open' ? 'green' : 'zinc'} size="sm" />{record.state}</span></ShelfRow>
                  {checks ? <ShelfRow label="Checks"><span>{checks.passed} passed · <span className={checks.failed ? 'text-red-600 dark:text-red-400' : ''}>{checks.failed} failing</span></span></ShelfRow> : null}
                  <ShelfRow label="People">
                    <span className="flex -space-x-1.5">
                      {[record.author, ...record.assignees].slice(0, 4).map((name) => (
                        <a key={name} href={githubUserUrl(auth.githubHost, name)} target="_blank" rel="noreferrer" aria-label={`Open ${name} on GitHub`} title={name}>
                          <Avatar name={name} src={githubAvatarUrl(auth.githubHost, name)} size="xs" className="!rounded-full ring-2 ring-white dark:ring-zinc-950" />
                        </a>
                      ))}
                    </span>
                  </ShelfRow>
                </dl>
                {context.kind === 'pull-request' ? <PrHealth repo={context.repo} number={context.number} /> : null}
                <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <h3 className="dim text-[10px] font-medium tracking-wide uppercase">Recent comments</h3>
                  {comments.length > 0 ? (
                    <div className="mt-3 space-y-4">
                      {comments.slice(-3).reverse().map((comment, index) => (
                        <Comment key={`${comment.author}:${comment.createdAt}:${index}`} comment={comment} githubHost={auth.githubHost} />
                      ))}
                    </div>
                  ) : <p className="dim mt-3 text-xs">No comments yet.</p>}
                </div>
                <a href={record.url} target="_blank" rel="noreferrer" className="dim mt-5 flex items-center gap-2 border-t border-zinc-200 pt-4 text-xs hover:text-zinc-900 dark:border-zinc-800 dark:hover:text-zinc-100">
                  <ExternalLinkIcon className="size-3.5" /> Open on GitHub
                </a>
              </aside>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}

function ContextPreviewSkeleton({ context, onBack }: { readonly context: DeskContextRef; readonly onBack: () => void }): React.JSX.Element {
  const line = 'animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800';
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#fcfcfb] dark:bg-zinc-950" aria-label={`Loading ${context.kind === 'pull-request' ? 'pull request' : 'issue'} context`} aria-busy="true">
      <div className="mx-auto w-full max-w-[92rem] px-6 py-5">
        <button type="button" className="dim cursor-pointer text-xs hover:text-zinc-900 dark:hover:text-zinc-100" onClick={onBack}>← Overview</button>
        <div className="mt-5">
          <div className={`${line} h-3 w-40`} />
          <div className={`${line} mt-3 h-7 w-[min(38rem,70%)]`} />
          <div className="mt-3 flex gap-2">
            <div className={`${line} h-3 w-16`} />
            <div className={`${line} h-3 w-28`} />
            <div className={`${line} h-3 w-24`} />
          </div>
        </div>

        <div className="mt-6 grid min-h-[34rem] grid-cols-[minmax(0,1fr)_21rem] gap-6">
          <div className="min-w-0">
            <section className="rounded-xl border border-zinc-200 bg-white px-6 py-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className={`${line} h-4 w-24`} />
              <div className="mt-5 space-y-3">
                <div className={`${line} h-3 w-full`} />
                <div className={`${line} h-3 w-[92%]`} />
                <div className={`${line} h-3 w-[72%]`} />
                <div className={`${line} mt-5 h-3 w-[86%]`} />
                <div className={`${line} h-3 w-[64%]`} />
              </div>
            </section>

            {context.kind === 'pull-request' ? (
              <section className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                  <div className={`${line} size-2.5 rounded-full`} />
                  <div className={`${line} h-3.5 w-20`} />
                  <div className={`${line} ml-auto h-3 w-16`} />
                </div>
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex h-10 items-center gap-3 border-b border-zinc-100 px-5 last:border-b-0 dark:border-zinc-900">
                    <div className={`${line} size-2 rounded-full`} />
                    <div className={`${line} h-3 w-44`} />
                    <div className={`${line} ml-auto h-3 w-14`} />
                  </div>
                ))}
              </section>
            ) : null}

            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <div className={`${line} h-3 w-48`} />
              <div className={`${line} mt-3 h-3 w-64`} />
              <div className="mt-8 flex items-center justify-between">
                <div className={`${line} h-3 w-52`} />
                <div className={`${line} size-8 rounded-lg`} />
              </div>
            </div>
          </div>

          <aside className="h-fit rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <div className={`${line} h-4 w-20`} />
            <div className="mt-6 flex gap-3">
              <div className={`${line} size-4 rounded-full`} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className={`${line} h-4 w-24`} />
                <div className={`${line} h-3 w-full`} />
                <div className={`${line} h-3 w-32`} />
              </div>
            </div>
            <div className="mt-6 space-y-4 border-t border-zinc-200 pt-5 dark:border-zinc-800">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex justify-between gap-4">
                  <div className={`${line} h-3 w-14`} />
                  <div className={`${line} h-3 w-24`} />
                </div>
              ))}
            </div>
            <div className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800">
              <div className={`${line} h-3 w-28`} />
              <div className={`${line} mt-4 h-3 w-full`} />
              <div className={`${line} mt-2 h-3 w-[78%]`} />
            </div>
          </aside>
        </div>
      </div>
    </main>
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

function checksTone(state: ChecksSummary['state']): 'blue' | 'amber' | 'red' | 'green' | 'zinc' {
  if (state === 'passing') return 'green';
  if (state === 'failing') return 'red';
  if (state === 'pending') return 'blue';
  if (state === 'unknown') return 'amber';
  return 'zinc';
}
