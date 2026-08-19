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
import type { DeskContextKind, DeskMissionView } from '../../contract/index.js';
import { missionStatus } from '../status.js';

type MissionKind = 'all' | DeskContextKind | 'unscoped';
type StatusFilter = 'all' | 'active' | 'review' | 'done';

interface MissionsOverviewProps {
  readonly missions: readonly DeskMissionView[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly prs: readonly PrListRecord[];
  readonly issues: readonly IssueListRecord[];
  readonly repos: readonly RepoRecord[];
  readonly repo: string | null;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onRepoChange: (repo: string | null) => void;
  readonly onOpen: (mission: DeskMissionView) => void;
  readonly onArchive: (mission: DeskMissionView) => void;
  readonly archivingId: string | null;
}

export function MissionsOverview({
  missions,
  loading,
  error,
  prs,
  issues,
  repos,
  repo,
  search,
  onSearch,
  onRepoChange,
  onOpen,
  onArchive,
  archivingId,
}: MissionsOverviewProps): React.JSX.Element {
  const [kind, setKind] = useState<MissionKind>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const contextRecords = useMemo(() => {
    const records = new Map<string, ContextRecord>();
    for (const pr of prs) records.set(`pull-request:${pr.repo}#${pr.number}`, { kind: 'pull-request', record: pr });
    for (const issue of issues) records.set(`issue:${issue.repo}#${issue.number}`, { kind: 'issue', record: issue });
    return records;
  }, [issues, prs]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return missions.filter((entry) => {
      const contexts = entry.mission.contexts;
      if (repo && entry.mission.repo !== repo && !contexts.some((context) => context.repo === repo)) return false;
      if (kind === 'unscoped' && contexts.length > 0) return false;
      if (kind !== 'all' && kind !== 'unscoped' && !contexts.some((context) => context.kind === kind)) return false;
      if (statusFilter !== 'all' && missionBucket(entry) !== statusFilter) return false;
      if (!needle) return true;
      const contextText = contexts.map((context) => `${context.kind} ${context.number} ${context.repo}`).join(' ');
      return `${entry.mission.title} ${entry.mission.repo ?? ''} ${contextText}`.toLowerCase().includes(needle);
    });
  }, [kind, missions, repo, search, statusFilter]);

  const active = missions.filter((entry) => missionBucket(entry) === 'active').length;
  const review = missions.filter((entry) => missionBucket(entry) === 'review').length;
  const repoOptions = [
    { value: '__all__', label: 'All repositories' },
    ...repos.map((entry) => ({ value: entry.fullName, label: entry.fullName })),
  ];

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#fcfcfb] dark:bg-zinc-950" aria-label="Missions overview">
      <div className="mx-auto w-full max-w-[92rem] px-6 py-6">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Missions</h1>
          <p className="dim text-xs tabular-nums">
            {active} active{review > 0 ? <> · {review} need review</> : null}
          </p>
        </div>
        <p className="dim mt-1 max-w-2xl text-xs leading-relaxed">
          Independent work keeps running when you open another mission or return to the repository overview.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <label className="relative w-full max-w-xs">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              className="h-8 w-full rounded-md border border-zinc-200 bg-white pr-3 pl-9 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:focus:border-zinc-600"
              placeholder="Search missions…"
              aria-label="Search missions"
            />
          </label>
          <div className="flex h-8 overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" role="group" aria-label="Mission target">
            <Segment active={kind === 'all'} onClick={() => setKind('all')}>All</Segment>
            <Segment active={kind === 'pull-request'} onClick={() => setKind('pull-request')}>Pull requests</Segment>
            <Segment active={kind === 'issue'} onClick={() => setKind('issue')}>Issues</Segment>
          </div>
          <Dropdown
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: 'All states' },
              { value: 'active', label: 'Active' },
              { value: 'review', label: 'Needs review' },
              { value: 'done', label: 'Completed' },
            ]}
            ariaLabel="Mission status"
            triggerClassName="flex h-8 min-w-32 cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 text-left text-xs dark:border-zinc-800 dark:bg-zinc-900"
          />
          <Dropdown
            value={repo ?? '__all__'}
            onChange={(value) => onRepoChange(value === '__all__' ? null : value)}
            options={repoOptions}
            ariaLabel="Repository"
            searchable={repoOptions.length > 7}
            triggerClassName="flex h-8 min-w-44 max-w-64 cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 text-left text-xs dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>

        <ErrorBar error={error} className="mt-4" />
        <section className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-label="Mission list">
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(10rem,1fr)_8rem_10rem_5rem] gap-4 border-b border-zinc-200 px-5 py-3 text-[10px] font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
            <span>Mission</span><span>Target</span><span>Status</span><span>Runtime</span><span className="text-right">Updated</span>
          </div>
          {loading && missions.length === 0 ? (
            <RowsSkeleton rows={6} />
          ) : visible.length === 0 ? (
            <p className="dim px-5 py-12 text-center text-xs">No missions match this view.</p>
          ) : visible.map((entry) => (
            <MissionRow
              key={entry.mission.id}
              entry={entry}
              contextRecords={contextRecords}
              onOpen={() => onOpen(entry)}
              onArchive={() => onArchive(entry)}
              archiving={archivingId === entry.mission.id}
            />
          ))}
        </section>
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

function MissionRow({
  entry,
  contextRecords,
  onOpen,
  onArchive,
  archiving,
}: {
  readonly entry: DeskMissionView;
  readonly contextRecords: ReadonlyMap<string, ContextRecord>;
  readonly onOpen: () => void;
  readonly onArchive: () => void;
  readonly archiving: boolean;
}): React.JSX.Element {
  const status = missionStatus(entry);
  const contexts = entry.mission.contexts;
  const runtime = entry.run?.harness.label ?? entry.mission.harness ?? 'Auto';
  const contextLabels = contexts.slice(0, 1).map((context) => `${context.kind === 'pull-request' ? 'PR' : 'Issue'} #${context.number}`);
  const overflow = contexts.length - contextLabels.length;
  const targetLabel = `${contextLabels.join(' · ')}${overflow > 0 ? ` · +${overflow} more` : ''}`;
  const contextRepos = [...new Set(contexts.map((context) => context.repo))];
  const targetScope = contextRepos.length === 1 ? contextRepos[0] : `${contextRepos.length} repositories`;
  const previewId = `mission-target-${entry.mission.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className="group grid min-h-14 grid-cols-[minmax(0,1.6fr)_minmax(10rem,1fr)_8rem_10rem_5rem] items-center gap-4 border-b border-zinc-100 px-5 py-2.5 text-xs last:border-b-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/70">
      <button type="button" className="min-w-0 cursor-pointer text-left" onClick={onOpen}>
        <span className="block truncate font-medium">{entry.mission.title}</span>
        <span className="dim mt-0.5 block truncate text-[10px]">
          {entry.pendingAsks.length > 0 ? 'Waiting for your decision' : entry.run?.outcome ?? currentStep(entry)}
        </span>
      </button>
      <div className="group/target relative min-w-0">
        <button type="button" className="w-full min-w-0 cursor-pointer text-left" onClick={onOpen} aria-describedby={contexts.length > 0 ? previewId : undefined}>
          {contexts.length > 0 ? (
            <>
              <span className="block truncate">{targetLabel}</span>
              <span className="dim mt-0.5 block truncate text-[10px]">{targetScope}</span>
            </>
          ) : (
            <span className="dim">{entry.mission.repo ?? 'Workspace'}</span>
          )}
        </button>
        {contexts[0] ? (
          <TargetPreview
            id={previewId}
            contexts={contexts}
            primary={contextRecords.get(contextKey(contexts[0])) ?? null}
          />
        ) : null}
      </div>
      <button type="button" className="flex cursor-pointer items-center gap-2 text-left" onClick={onOpen}>
        <StatusDot tone={status.tone} pulse={status.pulse} size="sm" label={status.label} />
        <span className={status.tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : status.tone === 'red' ? 'text-red-600 dark:text-red-400' : ''}>{status.label}</span>
      </button>
      <button type="button" className="dim min-w-0 cursor-pointer truncate text-left" onClick={onOpen}>{runtime}</button>
      <div className="relative text-right">
        <button type="button" className="dim cursor-pointer tabular-nums group-hover:opacity-0" onClick={onOpen}>{timeAgo(entry.mission.updatedAt)}</button>
        <button
          type="button"
          className="absolute top-1/2 right-0 -translate-y-1/2 cursor-pointer text-[10px] text-zinc-500 opacity-0 hover:text-red-600 group-hover:opacity-100 disabled:cursor-default dark:text-zinc-400 dark:hover:text-red-400"
          disabled={archiving}
          onClick={onArchive}
        >
          {archiving ? 'Archiving…' : 'Archive'}
        </button>
      </div>
    </div>
  );
}

interface ContextRecord {
  readonly kind: 'pull-request' | 'issue';
  readonly record: PrListRecord | IssueListRecord;
}

function TargetPreview({ id, contexts, primary }: { readonly id: string; readonly contexts: DeskMissionView['mission']['contexts']; readonly primary: ContextRecord | null }): React.JSX.Element {
  const context = contexts[0];
  if (!context) return <></>;
  const record = primary?.record ?? null;
  const extras = contexts.slice(1);

  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none invisible absolute top-full left-0 z-40 mt-2 w-80 translate-y-1 rounded-lg border border-zinc-200 bg-white p-4 text-left opacity-0 shadow-xl transition-[opacity,transform] duration-150 before:absolute before:-top-2 before:left-0 before:h-2 before:w-full before:content-[''] group-hover/target:pointer-events-auto group-hover/target:visible group-hover/target:translate-y-0 group-hover/target:opacity-100 group-focus-within/target:pointer-events-auto group-focus-within/target:visible group-focus-within/target:translate-y-0 group-focus-within/target:opacity-100 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-start gap-3">
        <StatusDot tone={record?.state === 'open' ? 'green' : 'zinc'} size="sm" className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{context.kind === 'pull-request' ? 'Pull request' : 'Issue'} #{context.number}</div>
          <div className="mt-1 line-clamp-2 text-xs font-semibold leading-relaxed">{record?.title ?? 'GitHub context'}</div>
          <div className="dim mt-1 truncate text-[10px]">{context.repo}</div>
        </div>
      </div>

      {record ? (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-zinc-100 pt-3 text-[10px] dark:border-zinc-800">
          <span className="dim capitalize">{record.state}</span>
          <span className="text-right">{record.comments} {record.comments === 1 ? 'comment' : 'comments'}</span>
          {primary?.kind === 'pull-request' ? (
            <span className="col-span-2 flex items-center gap-2">
              <span className="dim">Checks</span>
              <span className="ml-auto">{checksLabel((record as PrListRecord).checks)}</span>
            </span>
          ) : null}
        </div>
      ) : (
        <p className="dim mt-3 border-t border-zinc-100 pt-3 text-[10px] dark:border-zinc-800">Details are not in the current repository filter.</p>
      )}

      {extras.length > 0 ? (
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <div className="dim text-[9px] font-medium tracking-wide uppercase">Also attached</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {extras.slice(0, 4).map((extra) => (
              <span key={contextKey(extra)} className="rounded-md bg-zinc-100 px-2 py-1 text-[9px] dark:bg-zinc-800">{extra.kind === 'pull-request' ? 'PR' : 'Issue'} #{extra.number}</span>
            ))}
            {extras.length > 4 ? <span className="dim px-1 py-1 text-[9px]">+{extras.length - 4} more</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function checksLabel(checks: PrListRecord['checks']): string {
  if (!checks) return 'Not loaded';
  if (checks.state === 'none') return 'No checks';
  if (checks.state === 'unknown') return 'Unavailable';
  const details = [`${checks.passed}/${checks.total} passed`];
  if (checks.failed > 0) details.push(`${checks.failed} failing`);
  if (checks.pending > 0) details.push(`${checks.pending} pending`);
  return details.join(' · ');
}

function contextKey(context: DeskMissionView['mission']['contexts'][number]): string {
  return `${context.kind}:${context.repo}#${context.number}`;
}

function missionBucket(entry: DeskMissionView): Exclude<StatusFilter, 'all'> {
  const status = missionStatus(entry).label;
  if (entry.pendingAsks.length > 0 || status === 'Review' || status === 'Needs you') return 'review';
  if (status === 'Working' || status === 'Queued') return 'active';
  return 'done';
}

function currentStep(entry: DeskMissionView): string {
  const status = missionStatus(entry).label;
  if (status === 'Working') return 'Working in the background';
  if (status === 'Queued') return 'Waiting for a runner';
  if (status === 'Ready') return 'Ready for a follow-up';
  if (status === 'Paused') return 'Paused · follow up to reconnect';
  if (status === 'Draft') return 'No request sent yet';
  return status;
}
