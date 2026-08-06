import { useState } from 'react';
import { formatUsd } from '@companion/module-operate/contract';
import { ErrorBar, Eyebrow, Markdown, formatTokens, timeAgo } from '@moxxy/companion-sdk/ui';
import type { PrReviewBudgetProgress, PrReviewResult, ReviewPostMode } from '../../../contract/index.js';
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
  canReadRuns,
  canUseAgents,
  busy,
  onApply,
  onCancel,
  onDismiss,
  onUpdateFinding,
  focusedFinding = null,
  onFocusFinding,
  emphasis = 'auto',
}: {
  review: PrReviewResult;
  canAct: boolean;
  canReadRuns: boolean;
  canUseAgents: boolean;
  busy: boolean;
  onApply: (accountId?: string, mode?: ReviewPostMode) => void;
  onCancel: () => void;
  onDismiss: () => void;
  onUpdateFinding?: (id: string, patch: { state?: 'included' | 'rejected'; rejectionReason?: string }) => void;
  focusedFinding?: string | null;
  onFocusFinding?: (id: string | null) => void;
  emphasis?: 'auto' | 'hero';
}): JSX.Element {
  const [actAs, setActAs] = useState('');
  const [mode, setMode] = useState<ReviewPostMode>('full');
  const delegated = review.reviewMode === 'delegated';
  if (review.status === 'running') {
    return (
      <div className="flex flex-col gap-4">
        <ReviewingStage
          review={review}
          canCancel={canUseAgents || (canAct && review.providerId !== 'companion.native-review')}
          busy={busy}
          onCancel={onCancel}
        />
        {review.findings.length > 0 ? (
          <section className="card anim-in" aria-label="Findings available so far">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">Available so far</strong>
              <span className="badge">{review.findings.length}</span>
            </div>
            <p className="dim mt-1 text-xs">
              Findings appear as each review group finishes. Serious claims can still be confirmed or refuted by the
              independent verifier; anything already published by a posting pipeline is marked below.
            </p>
            <ReviewFindings
              reviewId={review.id}
              findings={review.findings}
              canAct={false}
              canReadAgent={false}
              canChat={false}
              busy={busy}
              live
              onToggle={() => undefined}
              onReject={() => undefined}
              focusedFinding={focusedFinding}
              {...(onFocusFinding ? { onFocusFinding } : {})}
            />
          </section>
        ) : null}
      </div>
    );
  }
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
  const manual = review.source === 'human';
  // A pending review needs the reviewer's attention — green, gently pulsing.
  const attn = pending && canAct && !delegated;
  const border = attn
    ? 'review-attn border-emerald-500/60 bg-gradient-to-b from-emerald-500/[0.06] to-transparent'
    : hero
      ? 'border-accent-500/50 bg-gradient-to-b from-accent-500/5 to-transparent'
      : review.status === 'applied'
        ? 'border-emerald-500/60'
        : review.status === 'dismissed' || review.status === 'cancelled'
          ? 'border-zinc-300 dark:border-zinc-700'
          : 'border-amber-500/60';

  return (
    <section className={`card anim-in ${border}`} aria-label="Code review">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{manual ? 'Your review' : 'Code review'}</strong>
        {!manual ? <span className="badge">{providerLabel(review.providerId)}</span> : null}
        {delegated ? <span className="badge-warn">delegated</span> : null}
        {v && !manual ? <span className={RISK_CLS[v.risk]}>{v.risk} risk</span> : null}
        {v && !manual ? <span className="badge">{v.recommendation.replace('_', ' ')}</span> : null}
        <span className="dim text-xs">
          {manual ? 'started' : delegated ? 'requested' : 'reviewed'} {timeAgo(review.createdAt)}
        </span>
        {canReadRuns && review.runId ? (
          <a className="linkish text-xs" href={`#/runs/${review.runId}`}>
            view run →
          </a>
        ) : null}
        <span className="flex-1" />
        {review.status === 'applied' ? <span className="badge-ok">posted</span> : null}
        {delegated && pending ? <span className="badge">waiting in provider</span> : null}
        {review.status === 'dismissed' ? <span className="badge">dismissed</span> : null}
        {review.status === 'cancelled' ? <span className="badge">cancelled</span> : null}
        {review.coverage.state === 'partial' && review.status === 'failed' ? (
          <span className="badge-warn">guidance only</span>
        ) : null}
      </div>

      {delegated ? (
        <div className="mt-3 rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3 text-[13px] dark:border-zinc-800 dark:bg-zinc-900/30">
          <p>{review.externalSummary ?? 'The review was handed off to the connected provider.'}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {review.externalUrl ? (
              <a className="btn-ghost" href={review.externalUrl} target="_blank" rel="noreferrer">
                Open provider activity ↗
              </a>
            ) : null}
            {pending && canAct ? (
              <button className="btn-ghost ml-auto" disabled={busy} onClick={onDismiss}>
                Dismiss hand-off
              </button>
            ) : null}
          </div>
        </div>
      ) : v ? (
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
              canReadAgent={canReadRuns}
              canChat={canUseAgents}
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
      ) : review.status === 'cancelled' ? (
        <p className="dim mt-3 text-[13px]">{review.error ?? 'This review was stopped before it produced a verdict.'}</p>
      ) : (
        <ErrorBar error={review.error ?? 'no verdict'} className="mt-3" />
      )}

      {review.coverage.state !== 'complete' && !manual && !delegated ? (
        <div className="banner-warn mt-3 text-xs">
          Coverage {review.coverage.state}: {review.coverage.reviewedFiles}/{review.coverage.totalFiles} changed files
          directly inspected. This result is guidance only and cannot be published as a complete review or used by an
          automatic merge gate.
        </div>
      ) : null}

      {review.progress.budget && !manual ? (
        <ReviewBudgetSummary budget={review.progress.budget} panel />
      ) : null}

      {pending && canAct && !delegated ? (
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

function providerLabel(providerId: string): string {
  if (providerId === 'companion.native-review') return 'Companion native';
  if (providerId === 'coderabbit.cli') return 'CodeRabbit CLI';
  if (providerId === 'cursor.bugbot') return 'Cursor Bugbot';
  return providerId;
}

function postLabel(mode: ReviewPostMode, selected: number): string {
  if (mode === 'summary') return 'Post summary to GitHub';
  if (selected === 0) return 'Post review to GitHub';
  const comments = `${selected} comment${selected === 1 ? '' : 's'}`;
  return mode === 'comments' ? `Post ${comments}` : `Post review + ${comments}`;
}

/** Animated placeholder shown while the review agent is still working. */
export function ReviewingStage({
  review,
  canCancel = false,
  busy = false,
  onCancel,
}: {
  review?: PrReviewResult;
  canCancel?: boolean;
  busy?: boolean;
  onCancel?: () => void;
}): JSX.Element {
  const progress = review?.progress;
  const budget = progress?.budget;
  const ratio = progress && progress.total > 0 ? Math.min(1, progress.completed / progress.total) : 0;
  const phase = progress?.phase ?? 'reviewing';
  const phaseLabel: Record<PrReviewResult['progress']['phase'], string> = {
    queued: 'Waiting for a runner',
    planning: 'Planning review coverage',
    reviewing: 'Reviewing changed files',
    verifying: 'Verifying findings',
    summarizing: 'Combining the evidence',
    complete: 'Finishing review',
  };
  return (
    <section className="anim-in rounded-2xl border border-accent-500/40 bg-gradient-to-b from-accent-500/10 to-transparent p-8 text-center">
      <div className="ppv-orb mx-auto flex size-16 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-600 dark:text-accent-400">
        <svg viewBox="0 0 24 24" fill="none" className="size-7" aria-hidden>
          <path d="M12 3l1.8 5L19 9.8 14 12l-2 5-2-5-5-2.2L10 8l2-5z" fill="currentColor" fillOpacity="0.9" />
        </svg>
      </div>
      <h2 className="mt-4 text-lg font-semibold">Reviewing this pull request</h2>
      <p className="dim mx-auto mt-1 max-w-md text-[13px]">
        {progress?.message ?? 'An agent is reading the diff and CI status.'}
      </p>
      <div className="mx-auto mt-4 flex max-w-sm items-center justify-center gap-2 text-xs">
        <span className="badge">{phaseLabel[phase]}</span>
        {progress && progress.total > 1 ? (
          <span className="dim tabular-nums">{progress.completed}/{progress.total}</span>
        ) : null}
      </div>
      <div className="mx-auto mt-3 h-1 w-56 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        {progress && progress.total > 0 ? (
          <div
            className="h-full rounded-full bg-accent-500 transition-[width] duration-500"
            style={{ width: `${Math.max(4, ratio * 100)}%` }}
            role="progressbar"
            aria-label="Pull request review progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
          />
        ) : (
          <div className="ppv-shimmer h-full w-full" />
        )}
      </div>
      {budget ? <ReviewBudgetSummary budget={budget} /> : null}
      {review && review.runIds.length > 0 ? (
        <p className="dim mt-3 text-xs">
          {review.runIds.length} agent run{review.runIds.length === 1 ? '' : 's'} ·{' '}
          <a className="linkish" href={`#/runs/${review.runIds[review.runIds.length - 1]}`}>
            view current run →
          </a>
        </p>
      ) : null}
      {canCancel && onCancel ? (
        <button className="btn-ghost mt-4" disabled={busy} onClick={onCancel}>
          {busy ? 'Cancelling…' : 'Cancel review'}
        </button>
      ) : null}
    </section>
  );
}

function ReviewBudgetSummary({
  budget,
  panel = false,
}: {
  budget: PrReviewBudgetProgress;
  panel?: boolean;
}): JSX.Element {
  const usage = budget.tokenUsage;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  const cost = usage ? reviewCost(usage.estimatedCostUsd, usage.costPartial, usage.reportedRuns) : null;
  return (
    <div
      className={`${panel ? 'mt-3 rounded-lg border border-zinc-200/80 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/30' : 'mt-3'} dim flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs tabular-nums`}
      aria-label="Aggregate review budget"
    >
      <span className="whitespace-nowrap">{budget.modelCalls}/{budget.maxModelCalls} agent calls</span>
      {usage ? (
        <>
          <span className="whitespace-nowrap">
            {formatTokens(totalTokens)}/{formatTokens(usage.maxTokens)} tokens
          </span>
          {usage.reportedRuns > 0 ? (
            <span className="whitespace-nowrap">
              {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
            </span>
          ) : null}
          {cost ? <span className="whitespace-nowrap">{cost}</span> : null}
          {usage.missingRuns > 0 ? (
            <span className="badge-danger">usage missing for {usage.missingRuns} run{usage.missingRuns === 1 ? '' : 's'}</span>
          ) : null}
        </>
      ) : null}
      <span className="whitespace-nowrap">
        hard stop at {new Date(budget.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  );
}

function reviewCost(knownUsd: number, partial: boolean, reportedRuns: number): string | null {
  if (reportedRuns === 0) return partial ? 'cost unavailable' : null;
  if (knownUsd === 0 && partial) return 'cost incomplete';
  const formatted = formatUsd(knownUsd);
  return partial ? `known cost ${formatted}` : `≈ ${formatted}`;
}
