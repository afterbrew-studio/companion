import { useMemo, useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  ListCard,
  ListFilterToolbar,
  Page,
  PageHeader,
  Spinner,
  StatusDot,
  facet,
  formatTokens,
  timeAgo,
  useListFilter,
  type FilterSelectField,
} from '@moxxy/companion-ui';
import { useWorkspace } from '@companion/module-workspace/client';
import type { RunKind, RunRecord, RunStatus } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRuns } from '../hooks/useRuns.js';
import { useWorkspaceRepos } from '../hooks/useWorkspaceRepos.js';

export function statusBadge(status: RunStatus, live: boolean): string {
  // Idle attended chats keep a live gateway but shouldn't read as active.
  if (status === 'idle') return 'badge';
  if (live || status === 'running' || status === 'review') return 'badge-ok';
  if (status === 'failed' || status === 'interrupted') return 'badge-danger';
  return 'badge';
}

const KIND_OPTIONS: ReadonlyArray<{ value: RunKind; label: string }> = [
  { value: 'interactive', label: 'Interactive chat' },
  { value: 'assistant', label: 'AI Help' },
  { value: 'triage', label: 'Triage' },
  { value: 'fix', label: 'Fix' },
  { value: 'analysis', label: 'Analysis / review' },
  { value: 'implement', label: 'Implement' },
  { value: 'report', label: 'Report' },
];

/** Coarse status buckets — what you actually filter by when hunting a run. */
const STATUS_OPTIONS = [
  { value: 'live', label: 'Live (gateway attached)' },
  { value: 'review', label: 'Needs review' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed / interrupted' },
  { value: 'stopped', label: 'Stopped / abandoned' },
] as const;

function matchesStatus(run: RunRecord, bucket: string): boolean {
  switch (bucket) {
    case 'live':
      return run.live;
    case 'failed':
      return run.status === 'failed' || run.status === 'interrupted';
    case 'stopped':
      return run.status === 'stopped' || run.status === 'abandoned';
    default:
      return run.status === bucket;
  }
}

export function RunsPage(): JSX.Element {
  const { runs: allRuns, error, setError } = useRuns();
  const { current } = useWorkspace();
  const wsRepos = useWorkspaceRepos(current?.id);
  // Scope to the active workspace: runs on its repos, plus instance-wide runs
  // (AI Help, reports, interactive chats) that belong to no workspace.
  const runs = useMemo(() => {
    const names = new Set(wsRepos.map((r) => r.fullName));
    return allRuns.filter((r) => r.repo === null || names.has(r.repo));
  }, [allRuns, wsRepos]);
  const [creating, setCreating] = useState(false);

  const createRun = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      const { run } = await api.createRun();
      location.hash = `#/runs/${run.id}`;
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const filterFields: Array<FilterSelectField<RunRecord>> = [
    {
      key: 'kind',
      label: 'Kind',
      allLabel: 'All kinds',
      options: KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label })),
      match: (run, v) => run.kind === v,
    },
    {
      key: 'status',
      label: 'Status',
      allLabel: 'Any status',
      options: STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label })),
      match: matchesStatus,
    },
    {
      key: 'repo',
      label: 'Repository',
      allLabel: 'All repositories',
      options: facet(runs, (r) => r.repo).map((r) => ({ value: r, label: r })),
      match: (run, v) => run.repo === v,
    },
  ];
  const filter = useListFilter(
    runs,
    (run, needle) =>
      run.title.toLowerCase().includes(needle) ||
      (run.repo ?? '').toLowerCase().includes(needle) ||
      run.id.includes(needle),
    filterFields,
  );
  const filtered = filter.filtered;

  return (
    <Page>
      <PageHeader
        title="Agent Runs"
        subtitle="Every agent session — chats, triage, fixes, reviews, reports"
        actions={
          <button className="btn" disabled={creating} onClick={() => void createRun()}>
            {creating ? 'Starting…' : 'New interactive run'}
          </button>
        }
      />
      <ErrorBar error={error} />

      {runs.length > 0 ? (
        <ListFilterToolbar
          filter={filter}
          fields={filterFields}
          total={runs.length}
          placeholder="Search title, repo, or run id…"
          searchLabel="Search runs"
        />
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          hint="Start an interactive run to chat with an agent, or trigger triage/fix/review from an issue or PR."
          action={
            <button className="btn" disabled={creating} onClick={() => void createRun()}>
              Start the first run
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No runs match" hint="Loosen the search or clear the filters." />
      ) : (
        <ListCard>
          {filtered.map((run) => (
            <a key={run.id} className="row-link" href={`#/runs/${run.id}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{run.title}</span>
                  {run.status === 'review' ? <span className="badge-warn shrink-0">needs review</span> : null}
                  {run.prUrl ? <span className="badge-ok shrink-0">PR ✓</span> : null}
                </span>
                <span className="dim block truncate text-xs">
                  {run.live ? 'live' : run.status} · {run.kind}
                  {run.model ? ` · ${run.model}` : ''}
                  {run.repo ? ` · ${run.repo}` : ''}
                  {run.inputTokens + run.outputTokens > 0
                    ? ` · ${formatTokens(run.inputTokens)} in · ${formatTokens(run.outputTokens)} out`
                    : ''}
                </span>
              </span>
              <span className="dim shrink-0" title={new Date(run.createdAt).toLocaleString()}>
                {timeAgo(run.createdAt)}
              </span>
              {run.live ? (
                <Spinner />
              ) : (
                <StatusDot
                  tone={
                    run.status === 'failed' || run.status === 'interrupted'
                      ? 'red'
                      : run.status === 'review'
                        ? 'amber'
                        : run.status === 'completed'
                          ? 'green'
                          : 'zinc'
                  }
                  title={run.status}
                />
              )}
            </a>
          ))}
        </ListCard>
      )}
    </Page>
  );
}
