import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Dropdown, EmptyState, ErrorBar, ListFooter, Page, SparkleIcon, Spinner, timeAgo } from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { FeaturePlanningSessionSummary } from '../../contract/index.js';
import { ideasApi } from '../api.js';
import { useIdeas } from '../hooks/useIdeas.js';

const EXAMPLES = [
  'Add analytics showing how many people view each listing',
  'Add a support chatbot that answers from our documentation',
  'Let customers pay for promoted listings',
];

export default function Ideas(): JSX.Element {
  const { current } = useWorkspace();
  const { can } = useAuth();
  const repos = useWorkspaceRepos(current?.id);
  const { sessions, legacyActiveCount, total, loading, hasMore, loadMore, error, setError } = useIdeas();
  const prefill = useMemo(readPrefill, []);
  const [repo, setRepo] = useState<string | null>(prefill.repo);
  const [idea, setIdea] = useState(prefill.idea);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ideaRef = useRef<HTMLTextAreaElement>(null);
  const sortedSessions = sessions ?? [];

  if (!current) return <EmptyState title="No workspace selected" />;
  const available = repos.filter((candidate) => candidate.githubAccessible);
  const selectedRepo = repo && available.some((candidate) => candidate.fullName === repo)
    ? repo
    : available[0]?.fullName ?? null;
  const newestSession = sortedSessions[0] ?? null;
  const olderSessions = sortedSessions.slice(1);

  const submit = async (): Promise<void> => {
    if (!selectedRepo || !idea.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await ideasApi.create({ workspaceId: current.id, repo: selectedRepo, idea: idea.trim() });
      window.location.hash = `/ideas/${session.id}`;
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-6xl">
      <div className="mx-auto flex min-h-[calc(100dvh-7rem)] w-full max-w-4xl flex-col justify-center py-8 sm:py-12 lg:py-16">
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">What would you like to build?</h1>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            Describe the outcome. Companion will prepare the plan and tasks.
          </p>
        </header>

        <ErrorBar error={error} className="mt-6" />

        <div className="ideas-composer-ambient relative mt-8">
          <form
            className="accent-field relative z-10 rounded-2xl border border-zinc-300 bg-white shadow-[0_18px_50px_-32px_rgba(24,24,27,0.45)] dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-[0_18px_55px_-32px_rgba(0,0,0,0.9)]"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="relative">
              <label htmlFor="idea-description" className="sr-only">What would you like to add or improve?</label>
              <textarea
                ref={ideaRef}
                id="idea-description"
                className="block min-h-48 w-full resize-y rounded-t-2xl bg-transparent px-5 py-5 pr-24 text-base leading-7 text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500 sm:min-h-52 sm:px-6 sm:py-6 sm:pr-28"
                value={idea}
                maxLength={8_000}
                aria-describedby="idea-character-count planning-safety-note"
                onChange={(event) => setIdea(event.target.value)}
                placeholder="Describe what you want to add or improve..."
              />
              <span id="idea-character-count" className="absolute right-5 top-5 text-xs tabular-nums text-zinc-400 dark:text-zinc-500 sm:right-6 sm:top-6">
                {idea.length.toLocaleString()} / 8,000
              </span>
            </div>

            <div className="flex flex-col gap-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1 sm:w-72 sm:flex-none">
                <Dropdown
                  ariaLabel="Repository"
                  value={selectedRepo}
                  onChange={setRepo}
                  options={repos.map((candidate) => ({
                    value: candidate.fullName,
                    label: candidate.fullName,
                    disabled: !candidate.githubAccessible,
                    hint: candidate.githubAccessible ? candidate.defaultBranch : 'GitHub access required',
                  }))}
                  triggerClassName="flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-zinc-50 px-3.5 text-left text-[13px] font-medium transition-colors hover:border-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950/50 dark:hover:border-zinc-500"
                  searchable
                />
              </div>

              {can('planner:manage') && can('runs:read') && can('runs:act') ? (
                <button
                  type="submit"
                  className="inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-emerald-600 px-5 text-[13px] font-semibold text-white shadow-sm transition-[background-color,transform] hover:bg-emerald-500 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400 dark:focus-visible:ring-offset-zinc-950 sm:w-auto"
                  disabled={busy || !selectedRepo || !idea.trim()}
                  aria-describedby="planning-safety-note"
                >
                  {busy ? <><Spinner /> Starting...</> : <><SparkleIcon /> Plan feature</>}
                </button>
              ) : null}
            </div>
          </form>
        </div>

        <p id="planning-safety-note" className="mt-3 text-center text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          Planning is read-only. Code changes begin only after your final confirmation.
        </p>

        <div className="mt-7 grid gap-1 sm:grid-cols-3" role="group" aria-label="Example ideas">
          {EXAMPLES.map((example, index) => (
            <button
              key={example}
              type="button"
              className={`group flex min-h-12 cursor-pointer items-start gap-2 rounded-lg px-3 py-2.5 text-left text-xs leading-5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100 ${index > 0 ? 'sm:border-l sm:border-zinc-200 sm:pl-5 dark:sm:border-zinc-800' : ''}`}
              onClick={() => {
                setIdea(example);
                ideaRef.current?.focus();
              }}
            >
              <span className="mt-px text-zinc-400 transition-transform group-hover:translate-x-0.5 dark:text-zinc-500" aria-hidden="true">→</span>
              <span>{example}</span>
            </button>
          ))}
        </div>

        {loading || newestSession ? (
          <section className="mx-auto mt-10 w-full max-w-3xl" aria-label="Recent ideas">
            {loading && !newestSession ? (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-zinc-500 dark:text-zinc-400"><Spinner /> Loading ideas...</div>
            ) : newestSession ? (
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <IdeaCard session={newestSession} />
                {olderSessions.length > 0 ? (
                  <div
                    id="older-ideas"
                    className="ideas-history-accordion"
                    data-open={showAll}
                    aria-hidden={!showAll}
                  >
                    <div>
                      <div className="divide-y divide-zinc-200 border-t border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                        {olderSessions.map((session) => (
                          <IdeaCard key={session.id} session={session} tabIndex={showAll ? 0 : -1} />
                        ))}
                        {showAll ? (
                          <ListFooter
                            loading={loading}
                            hasMore={hasMore}
                            shown={sortedSessions.length}
                            total={total}
                            noun="ideas"
                            onVisible={loadMore}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {total > 1 ? (
              <div className="mt-4 text-center">
                <button
                  type="button"
                  className="group inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
                  aria-controls="older-ideas"
                  aria-expanded={showAll}
                  onClick={() => setShowAll((visible) => !visible)}
                >
                  <span>{showAll ? 'Hide older ideas' : `View ${total - 1} more ${total === 2 ? 'idea' : 'ideas'}`}</span>
                  <span className="transition-transform duration-200 group-hover:translate-y-0.5" aria-hidden="true"><ChevronDown open={showAll} /></span>
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {legacyActiveCount > 0 ? (
          <a href="#/legacy-proposals" className="mx-auto mt-6 block max-w-3xl rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60">
            {legacyActiveCount} legacy proposal{legacyActiveCount === 1 ? '' : 's'} still need attention. Open legacy proposals.
          </a>
        ) : null}
      </div>
    </Page>
  );
}

function IdeaCard({ session, tabIndex }: { session: FeaturePlanningSessionSummary; tabIndex?: number }): JSX.Element {
  const currentStage = session.progress.stages[session.progress.currentIndex];
  return (
    <a href={`#/ideas/${session.id}`} tabIndex={tabIndex} className="group flex cursor-pointer flex-col gap-3 p-4 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-500 dark:hover:bg-zinc-800/50 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold group-hover:underline" title={session.title}>{session.title}</h3>
        <p className="dim mt-1 truncate font-mono text-xs">{session.repo}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3 sm:justify-end">
        <span className="dim text-xs">{currentStage?.label ?? 'Planning'}</span>
        <span className={session.status === 'failed' ? 'badge-danger' : session.status === 'completed' ? 'badge-ok' : 'badge'}>{session.status.replaceAll('_', ' ')}</span>
        <span className="dim min-w-14 text-right text-xs">{timeAgo(session.updatedAt)}</span>
        <span className="text-zinc-400 transition-transform group-hover:translate-x-0.5 dark:text-zinc-500" aria-hidden="true">→</span>
      </div>
    </a>
  );
}

function readPrefill(): { repo: string | null; idea: string } {
  const stored = sessionStorage.getItem('companion.idea.prefill');
  if (stored) {
    sessionStorage.removeItem('companion.idea.prefill');
    try {
      const parsed = JSON.parse(stored) as { repo?: unknown; idea?: unknown };
      if (typeof parsed.idea === 'string') {
        return { repo: typeof parsed.repo === 'string' ? parsed.repo : null, idea: parsed.idea.slice(0, 8_000) };
      }
    } catch {
      // Ignore corrupt browser-local prefill and fall through to the URL.
    }
  }
  const query = window.location.hash.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  return { repo: params.get('repo'), idea: params.get('idea') ?? '' };
}
