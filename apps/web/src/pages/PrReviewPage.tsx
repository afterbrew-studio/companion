import { useCallback, useEffect, useState } from 'react';
import type { PrRecord, PrReviewResult } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { DiffView } from '../components/DiffView.js';
import { Markdown } from '../components/Markdown.js';
import { AiActionMenu, Page, PageLoading, Spinner, timeAgo, type MenuAction } from '../components/ui.js';

/**
 * The agentic PR-review view — a focused, animated take on an AI code review:
 * the review's verdict (risk, recommendation, findings, the comment it will
 * post) beside the proposed code, with one-click post/dismiss and the follow-up
 * agent actions (fix checks, address feedback). Matches the PR-preview page.
 */
const RISK_CLS: Record<'low' | 'medium' | 'high', string> = {
  low: 'badge-ok',
  medium: 'badge-warn',
  high: 'badge-danger',
};

export function PrReviewPage({ repo, number }: { repo: string; number: number }): JSX.Element {
  const { can } = useAuth();
  const canAct = can('prs:act');
  const [pr, setPr] = useState<PrRecord | null>(null);
  const [review, setReview] = useState<PrReviewResult | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { pr, review } = await api.getPr(repo, number);
      setPr(pr);
      setReview(review);
    } catch (err) {
      setError(String(err));
    }
  }, [repo, number]);

  useEffect(() => {
    void refresh();
    api
      .prDiff(repo, number)
      .then((r) => setDiff(r.diff))
      .catch(() => setDiff(''));
  }, [refresh, repo, number]);

  useEffect(() => {
    return onServerMessage((msg) => {
      if ((msg.t === 'prs.changed' || msg.t === 'reports.changed') && (!('repo' in msg) || msg.repo === repo)) {
        setAnalyzing(false);
        void refresh();
      }
    });
  }, [refresh, repo]);

  if (!pr) return error ? <Page><div className="error-bar">{error}</div></Page> : <PageLoading label="Loading review…" />;

  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const runReview = (): void => {
    setAnalyzing(true);
    setError(null);
    void api.analyzePr(repo, number).catch((err) => {
      setError(String(err));
      setAnalyzing(false);
    });
  };

  const v = review?.verdict ?? null;
  // Follow-up agent actions — pushed to the PR's own branch, so they open the preview.
  const aiActions: MenuAction[] = [];
  if (canAct && pr.state === 'open') {
    aiActions.push({ label: 'Re-run AI review', onSelect: runReview });
    if (pr.checks?.state === 'failing') {
      aiActions.push({
        label: 'Fix failing checks',
        onSelect: () => void goPreview(() => api.fixChecks(repo, number)),
      });
    }
    if (pr.reviewDecision === 'changes_requested') {
      aiActions.push({
        label: 'Address review feedback',
        onSelect: () => void goPreview(() => api.addressReviews(repo, number)),
      });
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <nav className="dim text-[13px]" aria-label="Breadcrumb">
            <a href="#/reviews" className="hover:underline">
              Reviews
            </a>{' '}
            / {repo} / #{pr.number}
          </nav>
          <h1 className="mt-0.5 text-xl leading-snug font-semibold">{pr.title}</h1>
          <div className="dim mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={pr.state === 'open' ? 'badge-ok' : 'badge'}>{pr.state}</span>
            <span>#{pr.number}</span>
            {pr.headRef ? <code className="font-mono">{pr.headRef}</code> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2" role="toolbar" aria-label="Review actions">
          {aiActions.length > 0 ? <AiActionMenu label="AI actions" busy={analyzing} actions={aiActions} /> : null}
          <a className="btn-ghost" href={`#/repos/${repo}/prs/${pr.number}`}>
            Full PR
          </a>
          <a className="btn-ghost" href={pr.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>

      {analyzing && !v ? (
        <ReviewingStage />
      ) : v ? (
        <VerdictCard
          review={review!}
          verdict={v}
          canAct={canAct}
          busy={busy}
          onApply={() => void act('apply', () => api.applyPrReview(review!.id))}
          onDismiss={() => void act('dismiss', () => api.dismissPrReview(review!.id))}
        />
      ) : (
        <div className="rounded-2xl border border-zinc-200 p-8 text-center dark:border-zinc-800">
          <h2 className="text-sm font-semibold">No AI review yet</h2>
          <p className="dim mx-auto mt-1 max-w-md text-[13px]">
            Run an AI review — it reads the diff and CI status, then proposes a verdict you can post to GitHub.
          </p>
          {canAct ? (
            <button className="btn mt-4" onClick={runReview}>
              Run AI review
            </button>
          ) : null}
        </div>
      )}

      <div className="mt-5">
        <div className="dim mb-1.5 text-[11px] font-medium tracking-widest uppercase">Proposed change</div>
        {diff === null ? (
          <div className="dim flex items-center gap-2 py-6 text-sm">
            <Spinner /> Loading the diff…
          </div>
        ) : diff.trim() ? (
          <DiffView diff={diff} />
        ) : (
          <div className="banner-warn">No diff available for this pull request.</div>
        )}
      </div>

      {error ? <div className="error-bar mt-3">{error}</div> : null}
    </div>
  );
}

async function goPreview(start: () => Promise<{ run: { id: string } }>): Promise<void> {
  const { run } = await start();
  location.hash = `#/runs/${run.id}/preview`;
}

function ReviewingStage(): JSX.Element {
  return (
    <section className="anim-in rounded-2xl border border-accent-500/40 bg-gradient-to-b from-accent-500/10 to-transparent p-8 text-center">
      <div className="ppv-orb mx-auto flex size-16 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-600 dark:text-accent-400">
        <svg viewBox="0 0 24 24" fill="none" className="size-7" aria-hidden>
          <path d="M12 3l1.8 5L19 9.8 14 12l-2 5-2-5-5-2.2L10 8l2-5z" fill="currentColor" fillOpacity="0.9" />
        </svg>
      </div>
      <h2 className="mt-4 text-lg font-semibold">Reviewing this pull request</h2>
      <p className="dim mx-auto mt-1 max-w-md text-[13px]">
        An agent is reading the diff and CI status. Its verdict — risk, findings, and a review comment — appears here.
      </p>
      <div className="ppv-shimmer mx-auto mt-5 h-1 w-56 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" />
    </section>
  );
}

function VerdictCard({
  review,
  verdict,
  canAct,
  busy,
  onApply,
  onDismiss,
}: {
  review: PrReviewResult;
  verdict: NonNullable<PrReviewResult['verdict']>;
  canAct: boolean;
  busy: string | null;
  onApply: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const settled = review.status === 'applied' || review.status === 'dismissed';
  return (
    <section className="anim-in rounded-2xl border border-accent-500/50 bg-gradient-to-b from-accent-500/5 to-transparent p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={RISK_CLS[verdict.risk]}>{verdict.risk} risk</span>
        <span className="badge">{verdict.recommendation.replace('_', ' ')}</span>
        <span className="dim text-xs">reviewed {timeAgo(review.createdAt)}</span>
        <span className="flex-1" />
        {settled ? (
          <span className="badge-ok">{review.status}</span>
        ) : canAct ? (
          <>
            <button className="btn" disabled={busy !== null} onClick={onApply}>
              {busy === 'apply' ? 'Posting…' : 'Post review to GitHub'}
            </button>
            <button className="btn-ghost" disabled={busy !== null} onClick={onDismiss}>
              {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
            </button>
          </>
        ) : null}
      </div>

      <div className="mt-3">
        <Markdown text={verdict.summary} />
      </div>

      {verdict.findings.length > 0 ? (
        <div className="mt-3">
          <div className="dim mb-1 text-[11px] font-medium tracking-widest uppercase">Findings</div>
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            {verdict.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {verdict.reviewBody.trim() ? (
        <details className="mt-3">
          <summary className="dim cursor-pointer text-xs select-none">Review comment to post</summary>
          <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <Markdown text={verdict.reviewBody} />
          </div>
        </details>
      ) : null}
    </section>
  );
}
