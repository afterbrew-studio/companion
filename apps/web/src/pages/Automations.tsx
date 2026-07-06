import { useEffect, useState } from 'react';
import type { ReportRecord, RepoRecord, WebhookInfo } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function AutomationsPage(): JSX.Element {
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [{ repos }, { reports }] = await Promise.all([api.listRepos(), api.listReports()]);
      setRepos(repos);
      setReports(reports);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'reports.changed' || msg.t === 'repos.changed') void refresh();
    });
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Automations</h1>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}

      <div className="mt-4 flex flex-col gap-2.5">
        {repos.map((repo) => (
          <RepoAutomation key={repo.fullName} repo={repo} onChange={refresh} />
        ))}
        {repos.length === 0 ? <div className="dim py-5">Connect a repository first.</div> : null}
      </div>

      <h2 className="mt-7 mb-2.5 text-[15px] font-semibold">Reports</h2>
      <ul className="flex flex-col gap-2.5">
        {reports.map((r) => (
          <li key={r.id} className="card flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="badge">{r.kind}</span>
              <strong className="text-sm">{r.title}</strong>
              <span className="dim">{r.repo}</span>
              <span className="flex-1" />
              <span className="dim">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <pre className="dim max-h-64 overflow-y-auto text-[13px] whitespace-pre-wrap">{r.body}</pre>
          </li>
        ))}
        {reports.length === 0 ? <li className="dim py-5">No reports yet.</li> : null}
      </ul>
    </div>
  );
}

function RepoAutomation({ repo, onChange }: { repo: RepoRecord; onChange: () => Promise<void> }): JSX.Element {
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (fields: { autoTriage?: boolean; digest?: boolean; staleSweep?: boolean; prGate?: boolean }) => (): void => {
    void api
      .setAutomation(repo.fullName, fields)
      .then(onChange)
      .catch((e) => setError(String(e)));
  };

  return (
    <div className="card flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <strong>{repo.fullName}</strong>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={repo.autoTriage} onChange={toggle({ autoTriage: !repo.autoTriage })} />
          auto-triage new issues
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={repo.digestEnabled} onChange={toggle({ digest: !repo.digestEnabled })} />
          daily digest
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={repo.staleSweepEnabled} onChange={toggle({ staleSweep: !repo.staleSweepEnabled })} />
          stale sweep
        </label>
        <label className="flex items-center gap-1.5 text-[13px]" title="Auto-analyze newly opened PRs; a confident low-risk review is posted automatically. Merging is never automatic.">
          <input type="checkbox" checked={repo.prGateEnabled} onChange={toggle({ prGate: !repo.prGateEnabled })} />
          PR gate
        </label>
        <button className="btn-ghost" onClick={() => void api.digestNow(repo.fullName).catch((e) => setError(String(e)))}>
          Digest now
        </button>
        <button className="btn-ghost" onClick={() => void api.staleNow(repo.fullName).catch((e) => setError(String(e)))}>
          Stale sweep now
        </button>
        <button
          className="btn-ghost"
          onClick={() =>
            void api
              .webhookInfo(repo.fullName)
              .then(setWebhook)
              .catch((e) => setError(String(e)))
          }
        >
          {repo.webhookConfigured ? 'Webhook info' : 'Enable webhook'}
        </button>
      </div>
      {webhook ? (
        <div className="border-t border-dashed border-zinc-300 pt-2 text-[13px] dark:border-zinc-700">
          <p className="dim">
            Point a GitHub webhook (content type <code>application/json</code>, events: issues) at your tunnel or
            port-forward of:
          </p>
          <code className="mt-1 block">POST http://&lt;your-public-host&gt;{webhook.path}</code>
          <p className="dim mt-1">
            Secret: <code>{webhook.secret}</code>
          </p>
        </div>
      ) : null}
      {error ? <div className="error-bar">{error}</div> : null}
    </div>
  );
}
