import { useEffect, useState } from 'react';
import type { RunKind, RunRecord, RunStatus } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { Page, PageHeader, EmptyState, Spinner, timeAgo } from '../components/ui.js';
import { facet, useListFilter, ListFilterToolbar, type FilterSelectField } from '../lib/list-filter.js';

export function statusBadge(status: RunStatus, live: boolean): string {
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
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { runs } = await api.listRuns();
      setRuns(runs);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'runs.changed') void refresh();
      if (msg.t === 'run.changed') {
        setRuns((prev) => {
          const i = prev.findIndex((r) => r.id === msg.run.id);
          if (i === -1) return [msg.run, ...prev];
          const next = [...prev];
          next[i] = msg.run;
          return next;
        });
      }
    });
  }, []);

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
      {error ? <div className="error-bar">{error}</div> : null}

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
        <div className="card divide-y divide-zinc-200 p-0 dark:divide-zinc-800">
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
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    run.status === 'failed' || run.status === 'interrupted'
                      ? 'bg-red-500'
                      : run.status === 'review'
                        ? 'bg-amber-500'
                        : run.status === 'completed'
                          ? 'bg-emerald-500'
                          : 'bg-zinc-300 dark:bg-zinc-600'
                  }`}
                  aria-hidden
                  title={run.status}
                />
              )}
            </a>
          ))}
        </div>
      )}
    </Page>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
