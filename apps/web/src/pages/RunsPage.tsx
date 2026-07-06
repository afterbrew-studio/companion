import { useEffect, useState } from 'react';
import type { RunRecord, RunStatus } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

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
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent runs</h1>
        <button className="btn" disabled={creating} onClick={() => void createRun()}>
          {creating ? 'Starting…' : 'New interactive run'}
        </button>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}

      <ul className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
        {runs.map((run) => (
          <li key={run.id} className="flex">
            <a
              className="flex flex-1 items-center gap-2.5 px-1.5 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
              href={`#/runs/${run.id}`}
            >
              <span className={statusBadge(run.status, run.live)}>{run.live ? 'live' : run.status}</span>
              <span className="badge">{run.kind}</span>
              <span className="font-medium">{run.title}</span>
              {run.repo ? <span className="dim">{run.repo}</span> : null}
              {run.status === 'review' ? <span className="badge-warn">needs review</span> : null}
              {run.prUrl ? <span className="badge-ok">PR ✓</span> : null}
              <span className="dim ml-auto">{new Date(run.createdAt).toLocaleString()}</span>
            </a>
          </li>
        ))}
        {runs.length === 0 ? <li className="dim py-5">No runs yet.</li> : null}
      </ul>
    </div>
  );
}
