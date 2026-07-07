import { useCallback, useEffect, useState } from 'react';
import type { PrReviewResult, RunRecord, TriageResult, WorkspaceReviews } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { Markdown } from '../components/Markdown.js';
import { DiffView } from '../components/DiffView.js';
import { ActionMenu, Page, EmptyState, PageHeader, PageLoading, Tabs, timeAgo, useConfirm } from '../components/ui.js';

type ReviewTab = 'all' | 'runs' | 'prs' | 'triage';

/**
 * The review inbox: every stream that parks work on a human decision — agent
 * runs finished on a branch, AI PR reviews, and triage verdicts — in one
 * place, with approve/dismiss/follow-up right on the card.
 */
export function ReviewsPage(): JSX.Element {
  const { current } = useWorkspace();
  const [data, setData] = useState<WorkspaceReviews | null>(null);
  const [tab, setTab] = useState<ReviewTab>('all');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      setData(await api.workspaceReviews(current.id));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'run.changed' || msg.t === 'prs.changed' || msg.t === 'triage.changed') void refresh();
    });
  }, [refresh]);

  if (!current) return <EmptyState title="No workspace selected" />;
  if (!data) return <PageLoading label="Loading reviews…" />;

  const total = data.runs.length + data.prReviews.length + data.triage.length;
  const showRuns = tab === 'all' || tab === 'runs';
  const showPrs = tab === 'all' || tab === 'prs';
  const showTriage = tab === 'all' || tab === 'triage';

  return (
    <Page>
      <PageHeader title="Reviews" subtitle={`${current.name} — everything awaiting your decision`} />
      {error ? <div className="error-bar">{error}</div> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'all', label: 'All', count: total },
          { value: 'runs', label: 'Agent runs', count: data.runs.length },
          { value: 'prs', label: 'PR reviews', count: data.prReviews.length },
          { value: 'triage', label: 'Triage', count: data.triage.length },
        ]}
      />

      {total === 0 ? (
        <EmptyState
          title="Nothing waiting for review"
          hint="Agent runs that finish on a branch, AI PR reviews, and triage verdicts land here."
        />
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {showRuns ? data.runs.map((run) => <RunReviewCard key={run.id} run={run} onChange={refresh} onError={setError} />) : null}
          {showPrs
            ? data.prReviews.map(({ review, title }) => (
                <PrReviewCard key={review.id} review={review} title={title} onChange={refresh} onError={setError} />
              ))
            : null}
          {showTriage
            ? data.triage.map(({ triage, title }) => (
                <TriageCard key={triage.id} triage={triage} title={title} onChange={refresh} onError={setError} />
              ))
            : null}
        </div>
      )}
    </Page>
  );
}

interface CardProps {
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}

function CardShell({
  stream,
  title,
  meta,
  href,
  children,
}: {
  stream: string;
  title: string;
  meta: React.ReactNode;
  href: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <article className="card p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <span className="badge-accent shrink-0">{stream}</span>
        <a className="min-w-0 flex-1 truncate text-sm font-medium hover:underline" href={href}>
          {title}
        </a>
        <span className="dim shrink-0">{meta}</span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
    </article>
  );
}

/** An agent run parked on its branch: summary, diff, ship/discard/follow-up. */
function RunReviewCard({ run, onChange, onError }: { run: RunRecord } & CardProps): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const { confirmDanger, confirmElement } = useConfirm();

  const loadDiff = (): void => {
    if (diff !== null) return;
    api
      .runDiff(run.id)
      .then((r) => setDiff(r.diff))
      .catch((err) => onError(String(err)));
  };

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendFollowUp = async (): Promise<void> => {
    const text = followUp.trim();
    if (!text) return;
    await act(() => api.prompt(run.id, text));
    setFollowUp('');
  };

  return (
    <CardShell
      stream="Agent run"
      title={run.title}
      meta={
        <>
          {run.repo} · {run.branch ? <code className="text-[11px]">{run.branch}</code> : null} · {timeAgo(run.updatedAt)}
        </>
      }
      href={`#/runs/${run.id}`}
    >
      {run.outcome ? <Markdown text={run.outcome} /> : <p className="dim">The agent finished without a summary.</p>}

      <details onToggle={(e) => (e.currentTarget.open ? loadDiff() : undefined)}>
        <summary className="dim cursor-pointer text-xs select-none">Show diff</summary>
        {diff === null ? (
          <div className="dim mt-2">Loading diff…</div>
        ) : diff.trim() ? (
          <DiffView diff={diff} className="mt-2" />
        ) : (
          <div className="banner-warn mb-0">The agent produced no changes.</div>
        )}
      </details>

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <input
          className="input min-w-52 flex-1"
          placeholder="Ask the agent to fix something or add details…"
          value={followUp}
          disabled={busy}
          onChange={(e) => setFollowUp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void sendFollowUp();
          }}
        />
        <button className="btn-ghost" disabled={busy || !followUp.trim()} onClick={() => void sendFollowUp()}>
          Send to agent
        </button>
        <span className="flex-1" />
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const { prUrl } = await api.approvePr(run.id);
              window.open(prUrl, '_blank');
            })
          }
        >
          {busy ? 'Working…' : 'Approve → push + open PR'}
        </button>
        <ActionMenu
          label="Run review actions"
          actions={[
            { label: 'Open run', href: `#/runs/${run.id}` },
            {
              label: 'Discard run…',
              danger: true,
              disabled: busy,
              onSelect: () =>
                void (async () => {
                  const ok = await confirmDanger({
                    title: `Discard ${run.title}`,
                    message: 'The run’s worktree and branch are deleted. This cannot be undone.',
                    confirmLabel: 'Discard',
                  });
                  if (ok) await act(() => api.discardRun(run.id));
                })(),
            },
          ]}
        />
      </div>
      {confirmElement}
    </CardShell>
  );
}

const RISK_CLS: Record<string, string> = {
  low: 'badge-ok',
  medium: 'badge-warn',
  high: 'badge-danger',
};

/** A pending AI PR review verdict: apply it to GitHub or dismiss. */
function PrReviewCard({ review, title, onChange, onError }: { review: PrReviewResult; title: string } & CardProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const v = review.verdict;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardShell
      stream="PR review"
      title={`${title} · #${review.prNumber}`}
      meta={
        <>
          {review.repo} · {timeAgo(review.createdAt)}
        </>
      }
      href={`#/repos/${review.repo}/prs/${review.prNumber}`}
    >
      {v ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={RISK_CLS[v.risk] ?? 'badge'}>{v.risk} risk</span>
            <span className="badge">{v.recommendation.replace('_', ' ')}</span>
          </div>
          <Markdown text={v.summary} />
          {v.findings.length > 0 ? (
            <ul className="dim list-disc pl-5 text-[13px]">
              {v.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          {v.reviewBody.trim() ? (
            <details>
              <summary className="dim cursor-pointer text-xs select-none">Review comment to post</summary>
              <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <Markdown text={v.reviewBody} />
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="dim">No verdict — {review.error ?? 'the review run failed'}.</p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <button className="btn" disabled={busy || !v} onClick={() => void act(() => api.applyPrReview(review.id))}>
          {busy ? 'Working…' : 'Post review to GitHub'}
        </button>
        <ActionMenu
          label="PR review actions"
          actions={[
            { label: 'Open pull request', href: `#/repos/${review.repo}/prs/${review.prNumber}` },
            { label: 'Dismiss review', danger: true, disabled: busy, onSelect: () => void act(() => api.dismissPrReview(review.id)) },
          ]}
        />
      </div>
    </CardShell>
  );
}

const SEVERITY_CLS: Record<string, string> = {
  critical: 'badge-danger',
  high: 'badge-danger',
  medium: 'badge-warn',
  low: 'badge',
  trivial: 'badge',
};

/** A pending triage verdict: apply labels + draft reply or dismiss. */
function TriageCard({ triage, title, onChange, onError }: { triage: TriageResult; title: string } & CardProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const v = triage.verdict;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardShell
      stream="Triage"
      title={`${title} · #${triage.issueNumber}`}
      meta={
        <>
          {triage.repo} · {timeAgo(triage.createdAt)}
        </>
      }
      href={`#/repos/${triage.repo}/issues/${triage.issueNumber}`}
    >
      {v ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SEVERITY_CLS[v.severity] ?? 'badge'}>{v.severity}</span>
            <span className="badge">{v.kind}</span>
            {v.needsInfo ? <span className="badge-warn">needs info</span> : null}
            {v.duplicateOf ? <span className="badge-warn">duplicate of #{v.duplicateOf}</span> : null}
            {v.labels.map((l) => (
              <span key={l} className="chip">
                {l}
              </span>
            ))}
          </div>
          <Markdown text={v.summary} />
          {v.draftReply.trim() ? (
            <details>
              <summary className="dim cursor-pointer text-xs select-none">Draft reply to post</summary>
              <div className="mt-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <Markdown text={v.draftReply} />
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="dim">No verdict — {triage.error ?? 'the triage run failed'}.</p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <button className="btn" disabled={busy || !v} onClick={() => void act(() => api.applyTriage(triage.id, true))}>
          {busy ? 'Working…' : 'Apply labels + reply'}
        </button>
        <ActionMenu
          label="Triage actions"
          actions={[
            { label: 'Open issue', href: `#/repos/${triage.repo}/issues/${triage.issueNumber}` },
            { label: 'Dismiss verdict', danger: true, disabled: busy, onSelect: () => void act(() => api.dismissTriage(triage.id)) },
          ]}
        />
      </div>
    </CardShell>
  );
}
