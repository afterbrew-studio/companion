import { useEffect, useState } from 'react';
import type { IssueRecord, TriageResult } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function IssueDetail({ repo, number }: { repo: string; number: number }): JSX.Element {
  const [issue, setIssue] = useState<IssueRecord | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { issue, triage } = await api.getIssue(repo, number);
      setIssue(issue);
      setTriage(triage);
      if (triage && (triage.status === 'pending' || triage.status === 'applied')) setTriaging(false);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if ((msg.t === 'triage.changed' || msg.t === 'issues.changed') && msg.repo === repo) void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, number]);

  const startTriage = async (): Promise<void> => {
    setTriaging(true);
    setError(null);
    try {
      await api.triageIssue(repo, number);
    } catch (err) {
      setTriaging(false);
      setError(String(err));
    }
  };

  const startFix = async (): Promise<void> => {
    setError(null);
    try {
      const { run } = await api.fixIssue(repo, number);
      location.hash = `#/runs/${run.id}`;
    } catch (err) {
      setError(String(err));
    }
  };

  if (!issue) return <div className="mx-auto max-w-4xl px-6 py-6">{error ?? 'Loading…'}</div>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <a href={`#/repos/${repo}`} className="dim font-normal">
            {repo} /
          </a>{' '}
          #{issue.number}
        </h1>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={triaging} onClick={() => void startTriage()}>
            {triaging ? 'Triaging…' : triage ? 'Re-triage' : 'Triage'}
          </button>
          <button className="btn" onClick={() => void startFix()}>
            Fix this issue
          </button>
          <a className="btn-ghost" href={issue.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}

      <h2 className="mt-3 text-lg font-medium">{issue.title}</h2>
      <div className="dim mt-1 flex flex-wrap items-center gap-1.5">
        {issue.state} · by {issue.author} · {issue.comments} comments
        {issue.labels.map((l) => (
          <span key={l} className="chip">
            {l}
          </span>
        ))}
      </div>
      <pre className="card mt-4 max-h-96 overflow-y-auto text-[13px] whitespace-pre-wrap">
        {issue.body || '(no description)'}
      </pre>

      {triaging && !triage ? <div className="banner-info">Triage agent is investigating…</div> : null}
      {triage ? <TriageCard triage={triage} onChange={refresh} /> : null}
    </div>
  );
}

function TriageCard({ triage, onChange }: { triage: TriageResult; onChange: () => Promise<void> }): JSX.Element {
  const [comment, setComment] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const v = triage.verdict;
  const sevClass =
    v?.severity === 'critical' || v?.severity === 'high'
      ? 'badge-danger'
      : v?.severity === 'medium'
        ? 'badge-warn'
        : 'badge';

  return (
    <div
      className={`mt-4 rounded-xl border p-4 ${
        triage.status === 'applied' ? 'border-emerald-500/60' : 'border-amber-500/60'
      }`}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <strong>AI triage</strong>
        <span className={triage.status === 'applied' ? 'badge-ok' : 'badge-warn'}>{triage.status}</span>
        <a className="dim hover:underline" href={`#/runs/${triage.runId}`}>
          view run →
        </a>
      </div>
      {v ? (
        <>
          <p className="text-sm">{v.summary}</p>
          <div className="my-2 flex flex-wrap gap-1.5">
            <span className={sevClass}>{v.severity}</span>
            <span className="badge">{v.kind}</span>
            {v.labels.map((l) => (
              <span key={l} className="chip">
                +{l}
              </span>
            ))}
            {v.duplicateOf ? <span className="badge-accent">duplicate of #{v.duplicateOf}</span> : null}
            {v.needsInfo ? <span className="badge-warn">needs info</span> : null}
          </div>
          {v.draftReply ? (
            <blockquote className="my-2.5 border-l-2 border-zinc-300 py-1 pl-3 text-[13px] dark:border-zinc-600">
              <div className="dim">draft reply</div>
              {v.draftReply}
            </blockquote>
          ) : null}
          {triage.status === 'pending' ? (
            <div className="mt-2.5 flex items-center gap-2.5">
              <label className="dim flex items-center gap-1.5">
                <input type="checkbox" checked={comment} onChange={(e) => setComment(e.target.checked)} /> post the
                reply
              </label>
              <button
                className="btn"
                onClick={() =>
                  void api
                    .applyTriage(triage.id, comment)
                    .then(onChange)
                    .catch((e) => setError(String(e)))
                }
              >
                Apply to GitHub
              </button>
              <button
                className="btn-danger"
                onClick={() => void api.dismissTriage(triage.id).then(onChange).catch((e) => setError(String(e)))}
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="error-bar">{triage.error ?? 'no verdict'}</p>
      )}
      {error ? <div className="error-bar">{error}</div> : null}
    </div>
  );
}
