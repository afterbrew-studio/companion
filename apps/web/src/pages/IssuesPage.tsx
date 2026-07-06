import { useEffect, useMemo, useState } from 'react';
import type { IssueRecord, PrRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function IssuesPage({ repo }: { repo: string }): JSX.Element {
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [prs, setPrs] = useState<PrRecord[]>([]);
  const [tab, setTab] = useState<'open' | 'closed' | 'prs'>('open');
  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [{ issues }, { prs }] = await Promise.all([api.listIssues(repo), api.listPrs(repo)]);
      setIssues(issues);
      setPrs(prs);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (
        (msg.t === 'issues.changed' || msg.t === 'triage.changed' || msg.t === 'prs.changed') &&
        msg.repo === repo
      )
        void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const labels = useMemo(() => [...new Set(issues.flatMap((i) => i.labels))].sort(), [issues]);
  const filtered = issues.filter(
    (i) =>
      (tab === 'prs' ? false : i.state === tab) &&
      (!label || i.labels.includes(label)) &&
      (!query || `${i.number} ${i.title}`.toLowerCase().includes(query.toLowerCase())),
  );

  const rowClass =
    'flex flex-1 items-center gap-2.5 px-1.5 py-2.5 text-sm text-zinc-900 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-900';

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          <a href="#/repos" className="dim font-normal">
            repos /
          </a>{' '}
          {repo}
        </h1>
        <button className="btn-ghost" onClick={() => void api.syncRepo(repo).then(refresh)}>
          Sync
        </button>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}

      <div className="my-4 flex items-center gap-2.5">
        <div className="flex gap-1">
          {(['open', 'closed', 'prs'] as const).map((t) => (
            <button
              key={t}
              className={t === tab ? 'btn' : 'btn-ghost'}
              onClick={() => setTab(t)}
            >
              {t === 'prs' ? `PRs (${prs.length})` : `${t} (${issues.filter((i) => i.state === t).length})`}
            </button>
          ))}
        </div>
        {tab !== 'prs' ? (
          <>
            <input className="input" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="input" value={label} onChange={(e) => setLabel(e.target.value)}>
              <option value="">all labels</option>
              {labels.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {tab === 'prs'
          ? prs.map((pr) => (
              <li key={pr.number} className="flex">
                <a className={rowClass} href={`#/repos/${repo}/prs/${pr.number}`}>
                  <span className={pr.state === 'merged' ? 'badge-ok' : pr.state === 'open' ? 'badge-accent' : 'badge'}>
                    {pr.state}
                  </span>
                  {pr.draft ? <span className="badge-warn">draft</span> : null}
                  <span className="font-medium">
                    #{pr.number} {pr.title}
                  </span>
                  <span className="dim">{pr.headRef}</span>
                  {pr.review ? (
                    <span className={pr.review === 'applied' ? 'badge-ok' : 'badge-warn'}>review: {pr.review}</span>
                  ) : null}
                  <span className="dim ml-auto">{pr.author}</span>
                </a>
              </li>
            ))
          : filtered.map((issue) => (
              <li key={issue.number} className="flex">
                <a className={rowClass} href={`#/repos/${repo}/issues/${issue.number}`}>
                  <span className="font-medium">
                    #{issue.number} {issue.title}
                  </span>
                  {issue.labels.map((l) => (
                    <span key={l} className="chip">
                      {l}
                    </span>
                  ))}
                  {issue.triage ? (
                    <span className={issue.triage === 'applied' ? 'badge-ok' : 'badge-warn'}>
                      triage: {issue.triage}
                    </span>
                  ) : null}
                  <span className="dim ml-auto">{issue.author}</span>
                </a>
              </li>
            ))}
        {(tab === 'prs' ? prs.length : filtered.length) === 0 ? (
          <li className="dim py-5">{tab === 'prs' ? 'No pull requests.' : 'No matching issues.'}</li>
        ) : null}
      </ul>
    </div>
  );
}
