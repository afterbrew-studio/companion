import { useEffect, useState } from 'react';
import type { RunRecord, RunStatus } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { Page, PageHeader, EmptyState, Spinner, timeAgo } from '../components/ui.js';

export function statusBadge(status: RunStatus, live: boolean): string {
  if (live || status === 'running' || status === 'review') return 'badge-ok';
  if (status === 'failed' || status === 'interrupted') return 'badge-danger';
  return 'badge';
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
      ) : (
        <div className="card divide-y divide-zinc-200 p-0 dark:divide-zinc-800">
          {runs.map((run) => (
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
