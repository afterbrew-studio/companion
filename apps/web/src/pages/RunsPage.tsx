import { useEffect, useState } from 'react';
import type { MoxxyStatus, RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function RunsPage(): JSX.Element {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [{ runs }, status] = await Promise.all([api.listRuns(), api.status()]);
      setRuns(runs);
      setStatus(status);
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
    <div className="runs-page">
      <header className="page-header">
        <h1>Companion</h1>
        <button disabled={creating || !status?.compatible} onClick={() => void createRun()}>
          {creating ? 'Starting…' : 'New run'}
        </button>
      </header>

      {status ? <SetupBanner status={status} onImported={() => void refresh()} /> : null}
      {error ? <div className="error-bar">{error}</div> : null}

      <ul className="run-list">
        {runs.map((run) => (
          <li key={run.id}>
            <a href={`#/runs/${run.id}`}>
              <span className={`badge status-${run.status}`}>{run.live ? 'live' : run.status}</span>
              <span className="run-title">{run.title}</span>
              <span className="run-kind">{run.kind}</span>
              <span className="run-date">{new Date(run.createdAt).toLocaleString()}</span>
            </a>
          </li>
        ))}
        {runs.length === 0 ? <li className="empty">No runs yet — start one.</li> : null}
      </ul>
    </div>
  );
}

function SetupBanner({
  status,
  onImported,
}: {
  status: MoxxyStatus;
  onImported: () => void;
}): JSX.Element | null {
  const [importing, setImporting] = useState(false);
  const problems: JSX.Element[] = [];

  if (!status.cliPath) {
    problems.push(
      <div key="cli" className="banner warn">
        moxxy CLI not found — install it: <code>npm i -g @moxxy/cli</code>
      </div>,
    );
  } else if (!status.compatible) {
    problems.push(
      <div key="ver" className="banner warn">
        moxxy {status.cliVersion} is too old — upgrade: <code>npm i -g @moxxy/cli</code>
      </div>,
    );
  }
  if (status.cliPath && !status.providersImported) {
    problems.push(
      <div key="prov" className="banner info">
        No model providers configured yet.{' '}
        <button
          disabled={importing}
          onClick={() => {
            setImporting(true);
            void api
              .importProviders()
              .then(onImported)
              .finally(() => setImporting(false));
          }}
        >
          {importing ? 'Importing…' : 'Import from ~/.moxxy'}
        </button>{' '}
        (copies provider config + vault — a copy, not a sync)
      </div>,
    );
  }
  return problems.length > 0 ? <>{problems}</> : null;
}
