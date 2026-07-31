import { useState } from 'react';
import { ErrorBar, Eyebrow, Markdown, timeAgo } from '@moxxy/companion-sdk/ui';
import type { PrReviewResult, ReviewPostMode } from '../../../contract/index.js';
import { AccountPicker } from '../../components/AccountPicker.js';
import { ReviewFindings } from './ReviewFindings.js';

const RISK_CLS: Record<'low' | 'medium' | 'high', string> = {
  low: 'badge-ok',
  medium: 'badge-warn',
  high: 'badge-danger',
};

/**
 * The AI review verdict — risk, recommendation, findings, and the comment it
 * will post — with the post/dismiss controls (and the "act as" account picker).
 * Shared by the PR detail view and the review view; `emphasis="hero"` gives it
 * the accent treatment the review view leads with.
 */
export function PrReview({
  review,
  canAct,
  busy,
  onApply,
  onDismiss,
  onUpdateFinding,
  focusedFinding = null,
  onFocusFinding,
  emphasis = 'auto',
}: {
  review: PrReviewResult;
  canAct: boolean;
  busy: boolean;
  onApply: (accountId?: string, mode?: ReviewPostMode) => void;
  onDismiss: () => void;
  onUpdateFinding?: (id: string, patch: { state?: 'included' | 'rejected'; rejectionReason?: string }) => void;
  focusedFinding?: string | null;
  onFocusFinding?: (id: string | null) => void;
  emphasis?: 'auto' | 'hero';
}): JSX.Element {
  const [actAs, setActAs] = useState('');
  const [mode, setMode] = useState<ReviewPostMode>('full');
  const v = review.verdict;
  const pending = review.status === 'pending';
  const hero = emphasis === 'hero';
  const included = review.findings.filter((f) => f.state === 'included');
  const selected = included.length;
  // Findings with no anchor cannot be inline, so in comments mode they still
  // travel in the body. Saying so beats letting the reviewer discover it on
  // somebody else's pull request.
  const strays = included.filter((f) => f.anchor === null).length;
  // A draft a person started has no agent verdict to report; showing "low risk"
  // for it would attribute a judgement nobody made.
  const manual = review.runId === null;
  // A pending review needs the reviewer's attention — green, gently pulsing.
  const attn = pending && canAct;
  const border = attn
    ? 'review-attn border-emerald-500/60 bg-gradient-to-b from-emerald-500/[0.06] to-transparent'
    : hero
      ? 'border-accent-500/50 bg-gradient-to-b from-accent-500/5 to-transparent'
      : review.status === 'applied'
        ? 'border-emerald-500/60'
        : review.status === 'dismissed'
          ? 'border-zinc-300 dark:border-zinc-700'
          : 'border-amber-500/60';

  return (
    <section className={`card anim-in ${border}`} aria-label="AI review">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{manual ? 'Your review' : 'AI review'}</strong>
        {v && !manual ? <span className={RISK_CLS[v.risk]}>{v.risk} risk</span> : null}
        {v && !manual ? <span className="badge">{v.recommendation.replace('_', ' ')}</span> : null}
        <span className="dim text-xs">
          {manual ? 'started' : 'reviewed'} {timeAgo(review.createdAt)}
        </span>
        {review.runId ? (
          <a className="linkish text-xs" href={`#/runs/${review.runId}`}>
            view run →
          </a>
        ) : null}
        <span className="flex-1" />
        {review.status === 'applied' ? <span className="badge-ok">posted</span> : null}
        {review.status === 'dismissed' ? <span className="badge">dismissed</span> : null}
      </div>

      {v ? (
        <>
          {v.summary.trim() ? (
            <div className="mt-3">
              <Markdown text={v.summary} />
            </div>
          ) : null}

          {review.findings.length > 0 ? (
            <ReviewFindings
              reviewId={review.id}
              findings={review.findings}
              canAct={canAct && pending && !!onUpdateFinding}
              busy={busy}
              onToggle={(id, include) => onUpdateFinding?.(id, { state: include ? 'included' : 'rejected' })}
              onReject={(id, reason) => onUpdateFinding?.(id, { state: 'rejected', rejectionReason: reason })}
              focusedFinding={focusedFinding}
              {...(onFocusFinding ? { onFocusFinding } : {})}
            />
          ) : manual ? (
            <p className="dim mt-3 text-[13px]">
              Hover a line in the diff below and press <code>+</code> to comment on it.
            </p>
          ) : v.findings.length > 0 ? (
            // Reviews that predate anchored findings still carry only titles.
            <div className="mt-3">
              <Eyebrow className="mb-1">Findings</Eyebrow>
              <ul className="list-disc space-y-1 pl-5 text-[13px]">
                {v.findings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {v.reviewBody.trim() ? (
            <details className="mt-3" open={hero}>
              <summary className="dim cursor-pointer text-xs select-none">Review comment to post</summary>
              <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <Markdown text={v.reviewBody} />
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <ErrorBar error={review.error ?? 'no verdict'} className="mt-3" />
      )}

      {pending && canAct ? (
        <div className="mt-4 border-t border-zinc-200/80 pt-4 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <span className="dim mr-auto text-xs">Posts to GitHub as</span>
            <AccountPicker value={actAs} onChange={setActAs} />
            <select
              className="input w-auto text-xs"
              value={mode}
              onChange={(e) => setMode(e.target.value as ReviewPostMode)}
              aria-label="What to post"
            >
              <option value="full">Summary + inline comments</option>
              <option value="comments">Inline comments only</option>
              <option value="summary">Summary only</option>
            </select>
            <button className="btn-ghost" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
            <button className="btn" disabled={busy} onClick={() => onApply(actAs || undefined, mode)}>
              {busy ? 'Posting…' : postLabel(mode, selected)}
            </button>
          </div>
          {mode === 'comments' && strays > 0 ? (
            <p className="dim mt-2 text-right text-xs">
              {strays} selected finding{strays === 1 ? '' : 's'} {strays === 1 ? 'has' : 'have'} no line anchor and will
              still be listed in the review body.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function postLabel(mode: ReviewPostMode, selected: number): string {
  if (mode === 'summary') return 'Post summary to GitHub';
  if (selected === 0) return 'Post review to GitHub';
  const comments = `${selected} comment${selected === 1 ? '' : 's'}`;
  return mode === 'comments' ? `Post ${comments}` : `Post review + ${comments}`;
}

/** Animated placeholder shown while the review agent is still working. */
export function ReviewingStage(): JSX.Element {
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
