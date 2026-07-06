import { useEffect, useState } from 'react';
import type { PrRecord, PrReviewResult } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';

export function PrDetail({ repo, number }: { repo: string; number: number }): JSX.Element {
  const [pr, setPr] = useState<PrRecord | null>(null);
  const [review, setReview] = useState<PrReviewResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { pr, review } = await api.getPr(repo, number);
      setPr(pr);
      setReview(review);
      if (review && review.status !== 'failed') setAnalyzing(false);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'prs.changed' && msg.repo === repo) void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, number]);

  const analyze = async (): Promise<void> => {
    setAnalyzing(true);
    setError(null);
    try {
      await api.analyzePr(repo, number);
    } catch (err) {
      setAnalyzing(false);
      setError(String(err));
    }
  };

  const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!pr) return <div className="mx-auto max-w-4xl px-6 py-6">{error ?? 'Loading…'}</div>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <a href={`#/repos/${repo}`} className="dim font-normal">
            {repo} /
          </a>{' '}
          PR #{pr.number}
        </h1>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={analyzing} onClick={() => void analyze()}>
            {analyzing ? 'Analyzing…' : review ? 'Re-analyze' : 'AI review'}
          </button>
          {pr.state === 'open' ? (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Squash-merge PR #${pr.number}?`)) void act(() => api.mergePr(repo, number, 'squash'))();
                }}
              >
                Merge
              </button>
              <button
                className="btn-danger"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Close PR #${pr.number} without merging?`)) void act(() => api.closePr(repo, number))();
                }}
              >
                Close
              </button>
            </>
          ) : null}
          <a className="btn-ghost" href={pr.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}

      <h2 className="mt-3 text-lg font-medium">{pr.title}</h2>
      <div className="dim mt-1 flex flex-wrap items-center gap-1.5">
        <span className={pr.state === 'merged' ? 'badge-ok' : pr.state === 'open' ? 'badge-accent' : 'badge'}>
          {pr.state}
        </span>
        {pr.draft ? <span className="badge-warn">draft</span> : null}
        by {pr.author} · {pr.headRef} → {pr.baseRef}
      </div>
      <pre className="card mt-4 max-h-72 overflow-y-auto text-[13px] whitespace-pre-wrap">
        {pr.body || '(no description)'}
      </pre>

      {analyzing && !review ? <div className="banner-info">Review agent is reading the diff…</div> : null}
      {review ? <ReviewCard review={review} onChange={refresh} /> : null}
    </div>
  );
}

function ReviewCard({ review, onChange }: { review: PrReviewResult; onChange: () => Promise<void> }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const v = review.verdict;
  const riskClass = v?.risk === 'high' ? 'badge-danger' : v?.risk === 'medium' ? 'badge-warn' : 'badge-ok';

  return (
    <div
      className={`mt-4 rounded-xl border p-4 ${
        review.status === 'applied' ? 'border-emerald-500/60' : 'border-amber-500/60'
      }`}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <strong>AI review</strong>
        <span className={review.status === 'applied' ? 'badge-ok' : 'badge-warn'}>{review.status}</span>
        <a className="dim hover:underline" href={`#/runs/${review.runId}`}>
          view run →
        </a>
      </div>
      {v ? (
        <>
          <p className="text-sm">{v.summary}</p>
          <div className="my-2 flex flex-wrap gap-1.5">
            <span className={riskClass}>risk: {v.risk}</span>
            <span className="badge-accent">{v.recommendation.replace('_', ' ')}</span>
          </div>
          {v.findings.length > 0 ? (
            <ul className="mt-1.5 list-disc pl-5 text-[13px]">
              {v.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          <blockquote className="my-2.5 border-l-2 border-zinc-300 py-1 pl-3 text-[13px] whitespace-pre-wrap dark:border-zinc-600">
            <div className="dim">review to post</div>
            {v.reviewBody}
          </blockquote>
          {review.status === 'pending' ? (
            <div className="mt-2.5 flex items-center gap-2.5">
              <button
                className="btn"
                onClick={() =>
                  void api
                    .applyPrReview(review.id)
                    .then(onChange)
                    .catch((e) => setError(String(e)))
                }
              >
                Post review to GitHub
              </button>
              <button
                className="btn-danger"
                onClick={() =>
                  void api
                    .dismissPrReview(review.id)
                    .then(onChange)
                    .catch((e) => setError(String(e)))
                }
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="error-bar">{review.error ?? 'no verdict'}</p>
      )}
      {error ? <div className="error-bar">{error}</div> : null}
    </div>
  );
}
