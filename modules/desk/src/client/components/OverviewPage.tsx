import { useMemo, useState } from 'react';
import {
  Dropdown,
  ErrorBar,
  RowsSkeleton,
  SearchIcon,
  StatusDot,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import type { IssueListRecord, PrListRecord, RepoRecord } from '@companion/module-code/contract';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import type { DeskOverviewFeed } from '../hooks/useDeskOverview.js';
import { missionStatus } from '../status.js';

type KindFilter = 'all' | 'prs' | 'issues';
type AttentionFilter = 'all' | 'active' | 'attention';

interface OverviewPageProps {
  readonly workspace: WorkspaceRecord | null;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly repos: readonly RepoRecord[];
  readonly repo: string | null;
  readonly reposLoading: boolean;
  readonly feed: DeskOverviewFeed;
  readonly missions: readonly DeskMissionView[];
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onWorkspaceChange: (id: string) => void;
  readonly onRepoChange: (repo: string | null) => void;
  readonly onOpenContext: (context: DeskContextRef) => void;
}

export function OverviewPage({
  workspace,
  workspaces,
  repos,
  repo,
  reposLoading,
  feed,
  missions,
  search,
  onSearch,
  onWorkspaceChange,
  onRepoChange,
  onOpenContext,
}: OverviewPageProps): React.JSX.Element {
  const [kind, setKind] = useState<KindFilter>('all');
  const [attention, setAttention] = useState<AttentionFilter>('all');
  const missionByContext = useMemo(() => indexMissions(missions), [missions]);
  const needle = search.trim().toLowerCase();
  const visiblePrs = feed.prs.filter((pr) => matches(pr, needle) && visibleByAttention(pr, missionByContext, attention));
  const visibleIssues = feed.issues.filter((issue) => matches(issue, needle) && visibleByAttention(issue, missionByContext, attention));
  const attentionCount = feed.prs.filter(prNeedsAttention).length
    + missions.filter((entry) => entry.pendingAsks.length > 0).length;

  const workspaceOptions = workspaces.map((entry) => ({
    value: entry.id,
    label: entry.name,
    hint: `${entry.repoCount} ${entry.repoCount === 1 ? 'repo' : 'repos'}`,
  }));
  const repoOptions = [
    { value: '__all__', label: 'All repositories', hint: 'Workspace scope' },
    ...repos.map((entry) => ({
      value: entry.fullName,
      label: entry.fullName,
      hint: entry.githubAccessible ? entry.defaultBranch : 'Unavailable',
      disabled: !entry.githubAccessible,
    })),
  ];

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#fcfcfb] dark:bg-zinc-950" aria-label="Desk overview">
      <div className="mx-auto w-full max-w-[96rem] px-6 pt-4 pb-8">
        <div className="flex min-w-0 items-center gap-1 text-xs font-medium">
          <Dropdown
            value={workspace?.id ?? null}
            onChange={onWorkspaceChange}
            options={workspaceOptions}
            ariaLabel="Workspace"
            searchable={workspaceOptions.length > 7}
            triggerClassName="dim flex h-7 max-w-48 cursor-pointer items-center gap-1 rounded-md px-1.5 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          />
          <span className="dim">/</span>
          <Dropdown
            value={repo ?? '__all__'}
            onChange={(value) => onRepoChange(value === '__all__' ? null : value)}
            options={repoOptions}
            ariaLabel="Repository"
            searchable={repoOptions.length > 7}
            disabled={!workspace || reposLoading}
            placeholder={reposLoading ? 'Loading…' : 'All repositories'}
            triggerClassName="dim flex h-7 max-w-64 cursor-pointer items-center gap-1 rounded-md px-1.5 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          />
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="dim text-xs tabular-nums">
            {feed.totalPrs + feed.totalIssues} open
            {attentionCount > 0 ? <> · {attentionCount} need attention</> : null}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <label className="relative w-full max-w-xs">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              className="h-8 w-full rounded-md border border-zinc-200 bg-white pr-3 pl-9 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:focus:border-zinc-600"
              placeholder="Search pull requests and issues…"
              aria-label="Search pull requests and issues"
            />
          </label>
          <div className="flex h-8 overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" role="group" aria-label="Item type">
            <Segment active={kind === 'all'} onClick={() => setKind('all')}>All</Segment>
            <Segment active={kind === 'prs'} onClick={() => setKind('prs')}>PRs</Segment>
            <Segment active={kind === 'issues'} onClick={() => setKind('issues')}>Issues</Segment>
          </div>
          <Dropdown
            value={attention}
            onChange={setAttention}
            options={[
              { value: 'all', label: 'All states' },
              { value: 'active', label: 'Mission active' },
              { value: 'attention', label: 'Needs attention' },
            ]}
            ariaLabel="Attention filter"
            triggerClassName="flex h-8 min-w-32 cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 text-left text-xs dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>

        <ErrorBar error={feed.error} className="mt-4" />

        <div className={`mt-4 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${
          kind === 'all' ? 'grid grid-cols-1 xl:grid-cols-2' : ''
        }`}>
          {kind !== 'issues' ? (
            <WorkList
              title="Pull requests"
              loading={feed.loading}
              empty="No pull requests match this view."
              divided={kind === 'all'}
            >
              {visiblePrs.map((pr) => {
                const context: DeskContextRef = { kind: 'pull-request', repo: pr.repo, number: pr.number };
                const mission = missionByContext.get(contextKey(context)) ?? null;
                const state = prState(pr, mission);
                return (
                  <WorkRow
                    key={`${pr.repo}#${pr.number}`}
                    number={pr.number}
                    title={pr.title}
                    repo={repo ? null : pr.repo}
                    updatedAt={pr.updatedAt}
                    state={state}
                    onClick={() => onOpenContext(context)}
                  />
                );
              })}
            </WorkList>
          ) : null}
          {kind !== 'prs' ? (
            <WorkList title="Issues" loading={feed.loading} empty="No issues match this view.">
              {visibleIssues.map((issue) => {
                const context: DeskContextRef = { kind: 'issue', repo: issue.repo, number: issue.number };
                const mission = missionByContext.get(contextKey(context)) ?? null;
                const state = issueState(issue, mission);
                return (
                  <WorkRow
                    key={`${issue.repo}#${issue.number}`}
                    number={issue.number}
                    title={issue.title}
                    repo={repo ? null : issue.repo}
                    updatedAt={issue.updatedAt}
                    state={state}
                    onClick={() => onOpenContext(context)}
                  />
                );
              })}
            </WorkList>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function Segment({ active, onClick, children }: { readonly active: boolean; readonly onClick: () => void; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`cursor-pointer border-l border-zinc-200 px-4 text-xs first:border-l-0 dark:border-zinc-800 ${
        active ? 'bg-zinc-100 font-medium text-zinc-950 dark:bg-zinc-800 dark:text-zinc-50' : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function WorkList({
  title,
  loading,
  empty,
  divided,
  children,
}: {
  readonly title: string;
  readonly loading: boolean;
  readonly empty: string;
  readonly divided?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const count = Array.isArray(children) ? children.length : children ? 1 : 0;
  return (
    <section className={divided ? 'border-b border-zinc-200 xl:border-r xl:border-b-0 dark:border-zinc-800' : ''} aria-label={title}>
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h2 className="text-xs font-semibold">{title}</h2>
        <div className="dim mt-2 grid grid-cols-[minmax(0,1fr)_10rem_4.5rem] gap-3 text-[10px] font-medium tracking-wide uppercase">
          <span>Title</span><span>State</span><span className="text-right">Updated</span>
        </div>
      </div>
      {loading && count === 0 ? <RowsSkeleton rows={6} /> : count > 0 ? children : <p className="dim px-5 py-8 text-center text-xs">{empty}</p>}
    </section>
  );
}

interface RowState {
  readonly label: string;
  readonly tone: 'blue' | 'amber' | 'red' | 'green' | 'zinc';
  readonly pulse?: boolean;
}

function WorkRow({
  number,
  title,
  repo,
  updatedAt,
  state,
  onClick,
}: {
  readonly number: number;
  readonly title: string;
  readonly repo: string | null;
  readonly updatedAt: number;
  readonly state: RowState;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="group grid min-h-10 w-full cursor-pointer grid-cols-[minmax(0,1fr)_10rem_4.5rem] items-center gap-3 border-b border-zinc-100 px-5 py-2 text-left text-xs transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/70"
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-3">
        <StatusDot tone={state.tone} pulse={state.pulse} size="sm" label={state.label} />
        <span className="shrink-0 tabular-nums text-zinc-500">#{number}</span>
        <span className="min-w-0 truncate font-medium group-hover:text-zinc-950 dark:group-hover:text-white" title={title}>{title}</span>
        {repo ? <span className="dim hidden min-w-0 truncate 2xl:inline">{repo}</span> : null}
      </span>
      <span className={toneText(state.tone)}>{state.label}</span>
      <span className="dim text-right tabular-nums">{shortTimeAgo(updatedAt)}</span>
    </button>
  );
}

function indexMissions(missions: readonly DeskMissionView[]): Map<string, DeskMissionView> {
  const result = new Map<string, DeskMissionView>();
  for (const mission of missions) {
    const status = missionStatus(mission).label;
    if (!['Working', 'Queued', 'Review', 'Needs you'].includes(status)) continue;
    for (const context of mission.mission.contexts) {
      const key = contextKey(context);
      const current = result.get(key);
      if (!current || current.mission.updatedAt < mission.mission.updatedAt) result.set(key, mission);
    }
  }
  return result;
}

function contextKey(context: DeskContextRef): string {
  return `${context.kind}:${context.repo}#${context.number}`;
}

function matches(record: PrListRecord | IssueListRecord, needle: string): boolean {
  if (!needle) return true;
  return `${record.repo} ${record.number} ${record.title} ${record.author}`.toLowerCase().includes(needle);
}

function visibleByAttention(
  record: PrListRecord | IssueListRecord,
  missions: ReadonlyMap<string, DeskMissionView>,
  filter: AttentionFilter,
): boolean {
  if (filter === 'all') return true;
  const kind = 'checks' in record ? 'pull-request' : 'issue';
  const mission = missions.get(`${kind}:${record.repo}#${record.number}`);
  if (filter === 'active') return mission !== undefined && ['Working', 'Queued'].includes(missionStatus(mission).label);
  return mission?.pendingAsks.length ? true : 'checks' in record ? prNeedsAttention(record) : record.triage === 'pending';
}

function prNeedsAttention(pr: PrListRecord): boolean {
  return pr.checks?.state === 'failing' || pr.reviewDecision === 'changes_requested' || pr.mergeable === false;
}

function prState(pr: PrListRecord, mission: DeskMissionView | null): RowState {
  if (mission) {
    const status = missionStatus(mission);
    return { label: `${status.label} · Mission active`, tone: status.tone, pulse: status.pulse };
  }
  if (pr.checks?.state === 'failing') return { label: `${pr.checks.failed || 1} check failed`, tone: 'red' };
  if (pr.checks?.state === 'pending') return { label: 'Checks running', tone: 'blue', pulse: true };
  if (pr.reviewDecision === 'changes_requested') return { label: 'Changes requested', tone: 'amber' };
  if (pr.review === 'pending') return { label: 'Needs review', tone: 'amber' };
  if (pr.checks?.state === 'passing') return { label: 'Ready', tone: 'green' };
  return { label: pr.draft ? 'Draft' : 'Open', tone: 'zinc' };
}

function issueState(issue: IssueListRecord, mission: DeskMissionView | null): RowState {
  if (mission) {
    const status = missionStatus(mission);
    return { label: `${status.label} · Mission active`, tone: status.tone, pulse: status.pulse };
  }
  if (issue.triage === 'running') return { label: 'Triage running', tone: 'blue', pulse: true };
  if (issue.triage === 'pending') return { label: 'Needs review', tone: 'amber' };
  return { label: 'Open', tone: 'zinc' };
}

function toneText(tone: RowState['tone']): string {
  if (tone === 'green') return 'truncate text-emerald-600 dark:text-emerald-400';
  if (tone === 'red') return 'truncate text-red-600 dark:text-red-400';
  if (tone === 'amber') return 'truncate text-amber-600 dark:text-amber-400';
  if (tone === 'blue') return 'truncate text-blue-600 dark:text-blue-400';
  return 'dim truncate';
}

function shortTimeAgo(timestamp: number): string {
  return timeAgo(timestamp).replace(' ago', '');
}
