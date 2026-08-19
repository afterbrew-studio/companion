import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onServerMessage, useLive } from '@moxxy/companion-sdk/client';
import {
  ArrowUpIcon,
  Avatar,
  ChevronDown,
  ErrorBar,
  ExternalLinkIcon,
  Markdown,
  MicrophoneIcon,
  Spinner,
  StatusDot,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import type {
  CheckRunInfo,
  ChecksSummary,
  ChecksSnapshot,
  CommentRecord,
  IssueRecord,
  PrRecord,
  PrStatusSnapshot,
} from '@companion/module-code/contract';
import { codeApi, LabelChips } from '@companion/module-code/client';
import { useAuth } from '@companion/module-core/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { githubAvatarUrl, githubRepoUrl, githubUserUrl } from '../github.js';
import { missionStatus } from '../status.js';
import { useDictation } from '../hooks/useDictation.js';
import { PrHealth } from './PrHealth.js';
import { PrChangesPreview, PrContextIcon, PrMergeStatus } from './PrContextDetails.js';

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
  const [recordLoading, setRecordLoading] = useState(true);
  const [checksLoading, setChecksLoading] = useState(context.kind === 'pull-request');
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const refreshGeneration = useRef(0);
  const commentsInitialized = useRef(false);
  const checksInitialized = useRef(false);
  const checksInFlight = useRef(0);
  const latestPrStatus = useRef<PrStatusSnapshot | null>(null);
  const dictation = useDictation(prompt, setPrompt, starting);
  const related = useMemo(
    () => missions.filter((entry) => entry.mission.contexts.some((item) => contextKey(item) === contextKey(context))),
    [context, missions],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++refreshGeneration.current;
    setRecordLoading(true);
    if (!commentsInitialized.current) setCommentsLoading(true);
    setError(null);
    setCommentsError(null);

    const recordRequest = (context.kind === 'pull-request'
      ? codeApi.getPr(context.repo, context.number).then((detail) => detail.pr)
      : codeApi.getIssue(context.repo, context.number).then((detail) => detail.issue))
      .then((detail) => {
        if (request === refreshGeneration.current) {
          setRecord('draft' in detail && latestPrStatus.current ? { ...detail, ...latestPrStatus.current } : detail);
        }
      })
      .catch((err: unknown) => {
        if (request === refreshGeneration.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (request === refreshGeneration.current) setRecordLoading(false);
      });

    const commentsRequest = (context.kind === 'pull-request'
      ? codeApi.prComments(context.repo, context.number)
      : codeApi.issueComments(context.repo, context.number))
      .then((feed) => {
        if (request === refreshGeneration.current) setComments(feed.comments);
      })
      .catch((err: unknown) => {
        if (request === refreshGeneration.current) setCommentsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (request === refreshGeneration.current) {
          commentsInitialized.current = true;
          setCommentsLoading(false);
        }
      });

    let checksRequest: Promise<void> = Promise.resolve();
    if (context.kind === 'pull-request') {
      checksInFlight.current += 1;
      if (!checksInitialized.current) setChecksLoading(true);
      setChecksError(null);
      checksRequest = codeApi.prChecks(context.repo, context.number)
        .then((feed) => {
          if (request === refreshGeneration.current) setChecks(feed.checks);
        })
        .catch((err: unknown) => {
          if (request === refreshGeneration.current) setChecksError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          checksInFlight.current = Math.max(0, checksInFlight.current - 1);
          if (request === refreshGeneration.current) {
            checksInitialized.current = true;
            setChecksLoading(false);
          }
        });
    }

    await Promise.allSettled([recordRequest, commentsRequest, checksRequest]);
  }, [context.kind, context.number, context.repo]);

  useEffect(() => {
    refreshGeneration.current++;
    setRecord(null);
    setChecks(null);
    setComments([]);
    commentsInitialized.current = false;
    checksInitialized.current = false;
    checksInFlight.current = 0;
    latestPrStatus.current = null;
    setRecordLoading(true);
    setChecksLoading(context.kind === 'pull-request');
    setCommentsLoading(true);
    setChecksError(null);
    setCommentsError(null);
    setError(null);
  }, [context.kind, context.number, context.repo]);

  useLive(refresh, (message) => context.kind === 'pull-request'
    ? message.t === 'prs.changed' && message.repo === context.repo
    : (message.t === 'issues.changed' || message.t === 'triage.changed') && message.repo === context.repo);

  useEffect(() => onServerMessage((message) => {
    if (context.kind !== 'pull-request'
      || message.t !== 'prStatus.changed'
      || message.repo !== context.repo
      || message.number !== context.number) return;

    latestPrStatus.current = message.status;
    setRecord((current) => current && 'checks' in current ? { ...current, ...message.status } : current);
    if (checksInFlight.current > 0) return;

    const request = refreshGeneration.current;
    checksInFlight.current += 1;
    void codeApi.prChecks(context.repo, context.number)
      .then((feed) => {
        if (request === refreshGeneration.current) {
          setChecks(feed.checks);
          setChecksError(null);
        }
      })
      .catch((err: unknown) => {
        if (request === refreshGeneration.current) setChecksError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        checksInFlight.current = Math.max(0, checksInFlight.current - 1);
        if (request === refreshGeneration.current) {
          checksInitialized.current = true;
          setChecksLoading(false);
        }
      });
  }), [context.kind, context.number, context.repo]);

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

  if (recordLoading && !record) {
    return <ContextPreviewSkeleton context={context} onBack={onBack} />;
  }

  const compactChecks = context.kind === 'pull-request' && record && 'checks' in record ? record.checks : null;
  const visibleChecks: ChecksSummary | ChecksSnapshot | null = checks ?? compactChecks;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#fcfcfb] dark:bg-zinc-950" aria-label="Repository context" aria-busy={recordLoading}>
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

            <div className="mt-6 grid min-h-[34rem] grid-cols-[minmax(0,1fr)_21rem] items-start gap-6">
              <div className="min-w-0">
                <section className="min-h-48 rounded-xl border border-zinc-200 bg-white px-6 py-5 dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="context-description">
                  <h2 id="context-description" className="text-sm font-semibold">Description</h2>
                  {record.body ? (
                    <div className="markdown context-markdown mt-4 max-w-none text-sm leading-relaxed"><Markdown text={record.body} /></div>
                  ) : (
                    <p className="dim mt-3 text-sm">No description provided.</p>
                  )}
                </section>

                {context.kind === 'pull-request' ? (
                  <ChecksSection
                    summary={visibleChecks}
                    details={checks}
                    loading={checksLoading}
                    error={checksError}
                  />
                ) : null}

                <form
                  className="mt-4 flex min-h-40 flex-col rounded-xl border border-zinc-300 bg-white p-4 shadow-sm focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500"
                  onSubmit={(event) => { event.preventDefault(); void submit(); }}
                >
                  <textarea
                    rows={3}
                    className="max-h-48 min-h-20 w-full flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-zinc-400"
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

              <aside className="min-h-[31rem] rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950" aria-label="Context shelf">
                <h2 className="text-sm font-semibold">Context</h2>
                <div className="mt-5 flex items-start gap-3">
                  {context.kind === 'pull-request' ? <PrContextIcon pr={'draft' in record ? record : null} className="mt-0.5" /> : <span className="mt-0.5 text-xs font-semibold text-violet-600">#</span>}
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
                  {context.kind === 'pull-request' ? (
                    <ShelfRow label="Checks">
                      <CompactChecks summary={visibleChecks} loading={checksLoading} error={checksError} />
                    </ShelfRow>
                  ) : null}
                  {'draft' in record ? <ShelfRow label="Merge"><PrMergeStatus pr={record} /></ShelfRow> : null}
                  <ShelfRow label="Labels">
                    {record.labels.length > 0 ? <LabelChips labels={record.labels} /> : <span className="dim">None</span>}
                  </ShelfRow>
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
                {context.kind === 'pull-request' ? <PrChangesPreview repo={context.repo} number={context.number} /> : null}
                <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <h3 className="dim text-[10px] font-medium tracking-wide uppercase">Recent comments</h3>
                  {comments.length > 0 ? (
                    <div className="mt-3 space-y-4">
                      {comments.slice(-3).reverse().map((comment, index) => (
                        <Comment key={`${comment.author}:${comment.createdAt}:${index}`} comment={comment} githubHost={auth.githubHost} />
                      ))}
                    </div>
                  ) : commentsLoading ? (
                    <CommentsSkeleton />
                  ) : commentsError ? (
                    <p className="mt-3 text-xs text-red-600 dark:text-red-400">Comments unavailable.</p>
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

function ChecksSection({
  summary,
  details,
  loading,
  error,
}: {
  readonly summary: ChecksSummary | ChecksSnapshot | null;
  readonly details: ChecksSummary | null;
  readonly loading: boolean;
  readonly error: string | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const runs = details?.runs ?? [];
  const state = summary ? checkSummaryState(summary) : null;
  return (
    <section
      className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      aria-labelledby="context-checks"
      aria-busy={loading}
    >
      <button
        type="button"
        className={`flex min-h-12 w-full cursor-pointer items-center gap-3 px-5 py-3 text-left outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 dark:hover:bg-zinc-900/60 ${open ? 'border-b border-zinc-200 dark:border-zinc-800' : ''}`}
        aria-expanded={open}
        aria-controls="context-check-runs"
        onClick={() => setOpen((current) => !current)}
      >
        {summary ? <StatusDot tone={checksTone(summary.state)} pulse={summary.state === 'pending'} /> : <SkeletonDot />}
        <h2 id="context-checks" className="text-sm font-semibold">Checks</h2>
        {state ? <span className={state.className}>{state.label}</span> : loading ? <span className="dim text-xs">Loading status…</span> : null}
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          {summary ? <CheckCounts summary={summary} /> : error ? <span className="text-red-600 dark:text-red-400">Unavailable</span> : null}
        </span>
        <ChevronDown open={open} className="dim size-4 shrink-0" />
      </button>

      {open ? (
        <div id="context-check-runs">
          {runs.length > 0 ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {runs.map((run, index) => <CheckRun key={`${run.name}:${index}`} run={run} />)}
            </ul>
          ) : loading && !summary ? (
            <CheckRowsSkeleton rows={3} />
          ) : loading && summary ? (
            <div className="flex min-h-10 items-center gap-3 px-5 py-2 text-xs">
              <StatusDot tone={checksTone(summary.state)} pulse={summary.state === 'pending'} size="sm" />
              <span className="font-medium">{checkAggregateLabel(summary)}</span>
              <span className="dim ml-auto">Loading individual jobs…</span>
            </div>
          ) : (
            <p className={`px-5 py-4 text-xs ${error ? 'text-red-600 dark:text-red-400' : 'dim'}`}>
              {error ? 'Check details are unavailable.' : summary?.state === 'none' ? 'No checks reported for this commit.' : summary?.state === 'unknown' ? 'GitHub check status is unavailable.' : 'No individual check runs reported.'}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CheckRun({ run }: { readonly run: CheckRunInfo }): React.JSX.Element {
  const outcome = checkRunOutcome(run);
  const duration = checkRunDuration(run);
  return (
    <li className="flex min-h-10 items-center gap-3 px-5 py-2 text-xs">
      <StatusDot tone={outcome.tone} pulse={outcome.pulse} size="sm" />
      <span className="min-w-0 flex-1 truncate font-medium" title={run.name}>{run.name}</span>
      {duration ? <span className="dim shrink-0 tabular-nums">{duration}</span> : null}
      <span className={outcome.className}>{outcome.label}</span>
      {run.detailsUrl ? <a href={run.detailsUrl} target="_blank" rel="noreferrer" className="dim shrink-0 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">Logs ↗</a> : null}
    </li>
  );
}

function CompactChecks({
  summary,
  loading,
  error,
}: {
  readonly summary: ChecksSummary | ChecksSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
}): React.JSX.Element {
  if (summary) return <span className="tabular-nums"><CheckCounts summary={summary} /></span>;
  if (loading) return <span className="block h-3 w-24 animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" aria-label="Loading checks" />;
  return <span className={error ? 'text-red-600 dark:text-red-400' : 'dim'}>{error ? 'Unavailable' : 'Not checked'}</span>;
}

function CheckCounts({ summary }: { readonly summary: ChecksSummary | ChecksSnapshot }): React.JSX.Element {
  if (summary.state === 'none') return <>No checks</>;
  if (summary.state === 'unknown') return <span className="text-amber-600 dark:text-amber-400">Unavailable</span>;
  return (
    <>
      <span className={summary.passed > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}>{summary.passed} passed</span>
      {summary.failed > 0 ? <> · <span className="text-red-600 dark:text-red-400">{summary.failed} failing</span></> : null}
      {summary.pending > 0 ? <> · <span className="text-blue-600 dark:text-blue-400">{summary.pending} running</span></> : null}
    </>
  );
}

function CheckRowsSkeleton({ rows }: { readonly rows: number }): React.JSX.Element {
  const line = 'animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800';
  return (
    <div aria-label="Loading check details">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-10 items-center gap-3 border-b border-zinc-100 px-5 last:border-b-0 dark:border-zinc-900">
          <span className={`${line} size-2 rounded-full`} />
          <span className={`${line} h-3 w-44 max-w-[45%]`} />
          <span className={`${line} ml-auto h-3 w-14`} />
        </div>
      ))}
    </div>
  );
}

function CommentsSkeleton(): React.JSX.Element {
  const line = 'animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800';
  return (
    <div className="mt-3 flex items-start gap-2.5" aria-label="Loading comments">
      <span className={`${line} size-5 shrink-0 rounded-full`} />
      <span className="min-w-0 flex-1 space-y-2">
        <span className={`${line} block h-2.5 w-24`} />
        <span className={`${line} block h-2.5 w-full`} />
        <span className={`${line} block h-2.5 w-3/4`} />
      </span>
    </div>
  );
}

function SkeletonDot(): React.JSX.Element {
  return <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" />;
}

function checkSummaryState(summary: ChecksSummary | ChecksSnapshot): { readonly label: string; readonly className: string } {
  if (summary.state === 'passing') return { label: 'Passed', className: 'text-xs text-emerald-600 dark:text-emerald-400' };
  if (summary.state === 'failing') return { label: 'Needs attention', className: 'text-xs text-red-600 dark:text-red-400' };
  if (summary.state === 'pending') return { label: 'Checks running', className: 'text-xs text-blue-600 dark:text-blue-400' };
  if (summary.state === 'unknown') return { label: 'Unavailable', className: 'text-xs text-amber-600 dark:text-amber-400' };
  return { label: 'Not configured', className: 'dim text-xs' };
}

function checkAggregateLabel(summary: ChecksSummary | ChecksSnapshot): string {
  if (summary.state === 'passing') return `All ${summary.total} checks passed`;
  if (summary.state === 'failing') return `${summary.failed} of ${summary.total} checks failing`;
  if (summary.state === 'pending') return `${summary.pending} of ${summary.total} checks running`;
  if (summary.state === 'unknown') return 'Check status unavailable';
  return 'No checks configured';
}

function checkRunOutcome(run: CheckRunInfo): {
  readonly label: string;
  readonly tone: 'blue' | 'amber' | 'red' | 'green' | 'zinc';
  readonly pulse: boolean;
  readonly className: string;
} {
  if (run.status === 'queued') return { label: 'Queued', tone: 'blue', pulse: true, className: 'shrink-0 text-blue-600 dark:text-blue-400' };
  if (run.status === 'in_progress') return { label: 'Running', tone: 'blue', pulse: true, className: 'shrink-0 text-blue-600 dark:text-blue-400' };
  if (run.conclusion === 'success') return { label: 'Passed', tone: 'green', pulse: false, className: 'shrink-0 text-emerald-600 dark:text-emerald-400' };
  if (run.conclusion === 'neutral') return { label: 'Neutral', tone: 'zinc', pulse: false, className: 'dim shrink-0' };
  if (run.conclusion === 'skipped') return { label: 'Skipped', tone: 'zinc', pulse: false, className: 'dim shrink-0' };
  if (run.conclusion === 'cancelled') return { label: 'Cancelled', tone: 'zinc', pulse: false, className: 'dim shrink-0' };
  if (run.conclusion === 'stale') return { label: 'Stale', tone: 'amber', pulse: false, className: 'shrink-0 text-amber-600 dark:text-amber-400' };
  return { label: run.conclusion === 'timed_out' ? 'Timed out' : run.conclusion === 'action_required' ? 'Action required' : 'Failed', tone: 'red', pulse: false, className: 'shrink-0 text-red-600 dark:text-red-400' };
}

function checkRunDuration(run: CheckRunInfo): string | null {
  if (run.startedAt === null || run.completedAt === null) return null;
  const seconds = Math.max(0, Math.round((run.completedAt - run.startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
