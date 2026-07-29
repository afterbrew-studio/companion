import { useCallback, useState } from 'react';
import {
  ActionMenu,
  Breadcrumb,
  EmptyState,
  ErrorBar,
  Eyebrow,
  InlineLoading,
  Markdown,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Skeleton,
  Spinner,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import { useLive, type RouteProps } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { SlopDetectionResult } from '../../contract/index.js';
import { slopApi } from '../api.js';
import { ContributorProvenance } from '../components/ContributorProvenance.js';
import { SlopScore, SlopScoreSkeleton } from '../components/SlopScore.js';
import { SlopSignals, SlopSignalsSkeleton } from '../components/SlopSignals.js';
import { ACTION_LABEL, STATUS_META } from '../detection-meta.js';

/**
 * One detection in full, ordered by what a maintainer decides with: the score
 * and the action at the top, then what to ask the author, then the evidence
 * behind it. Detail that only matters once you go looking (each observation,
 * the draft comment, the scale, the run that produced all this) waits behind a
 * click or in the footer. Deep-linkable as #/slop/:id.
 */
export default function SlopDetection({ params }: RouteProps): JSX.Element {
  const id = params.id!;
  const { can } = useAuth();
  const { current } = useWorkspace();
  // undefined = loading, null = not found (or inaccessible — same 404 either way).
  const [detection, setDetection] = useState<SlopDetectionResult | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDetection((await slopApi.get(id)).detection);
    } catch {
      setDetection(null);
    }
  }, [id]);
  useLive(refresh, (msg) => msg.t === 'slop.changed');

  const crumbs = (label: string): JSX.Element => (
    <Breadcrumb items={[{ label: 'Slop Detection', href: '#/slop' }, { label }]} />
  );

  if (detection === undefined) {
    return (
      <Page>
        {crumbs('Detection')}
        <PageLoading label="Loading detection…" />
      </Page>
    );
  }
  if (detection === null) {
    return (
      <Page>
        {crumbs('Detection')}
        <EmptyState
          title="Detection not found"
          hint="It may have been removed, or it lives in a workspace you can't access."
        />
      </Page>
    );
  }

  const d = detection;
  const verdict = d.verdict;
  const meta = STATUS_META[d.status];
  const canAct = can('slop:act');
  const canRefine = can('refine:manage');

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const actions =
    canAct && d.status === 'pending' && verdict ? (
      <div className="flex flex-wrap items-center gap-2">
        {busy ? <Spinner /> : null}
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => slopApi.dismiss(d.id))}>
          Dismiss
        </button>
        {canRefine && current ? (
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const { refinementId } = await slopApi.moveToRefinement(d.id, current.id);
                window.location.hash = `/refinement/${refinementId}`;
              })
            }
          >
            Move to refinement
          </button>
        ) : null}
        <ActionMenu
          actions={[
            ...(['label', 'comment', 'request_changes'] as const)
              .filter((a) => a !== verdict.recommendedAction)
              .map((action) => ({
                label: `Apply — ${ACTION_LABEL[action]}`,
                onSelect: () => void act(() => slopApi.apply(d.id, { action })),
              })),
            ...(verdict.recommendedAction !== 'close'
              ? [
                  {
                    label: 'Apply — close PR',
                    danger: true,
                    onSelect: () => void act(() => slopApi.apply(d.id, { action: 'close' })),
                  },
                ]
              : []),
          ]}
        />
        <button className="btn" disabled={busy} onClick={() => void act(() => slopApi.apply(d.id, {}))}>
          Apply recommended — {ACTION_LABEL[verdict.recommendedAction]}
        </button>
      </div>
    ) : canAct && d.status === 'failed' ? (
      <div className="flex items-center gap-2">
        {busy ? <Spinner /> : null}
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => slopApi.dismiss(d.id))}>
          Dismiss
        </button>
      </div>
    ) : undefined;

  return (
    <Page>
      {crumbs(`${d.repo}#${d.prNumber}`)}
      <PageHeader
        title={d.prTitle}
        subtitle={
          <span className="flex items-center gap-2 text-xs">
            <a className="linkish font-mono" href={`#/repos/${d.repo}/prs/${d.prNumber}`}>
              {d.repo}#{d.prNumber}
            </a>
            <MetaSignal tone={meta.tone} label={meta.label} pulse={d.status === 'running'} />
          </span>
        }
        actions={actions}
      />
      <ErrorBar error={error} className="mb-3" />

      <div className="flex max-w-3xl flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-2 md:items-start">
          {verdict ? (
            <SlopScore verdict={verdict} appliedAction={d.appliedAction} />
          ) : d.status === 'running' ? (
            <SlopScoreSkeleton />
          ) : (
            <div>
              <Eyebrow>AI likelihood</Eyebrow>
              <p className="mt-1.5 text-sm">not scored</p>
            </div>
          )}
          <ContributorProvenance provenance={d.provenance} />
        </div>

        {d.status === 'failed' ? (
          <p className="error-bar text-xs wrap-anywhere">{d.error ?? 'detection failed'}</p>
        ) : null}

        {verdict ? (
          <>
            <div>
              <Eyebrow>Verdict</Eyebrow>
              <p className="mt-1.5 text-sm wrap-anywhere">{verdict.summary}</p>
            </div>

            {verdict.reviewerHints.length > 0 ? (
              <div className="well">
                <Eyebrow>Suggestions for the author</Eyebrow>
                <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px]">
                  {verdict.reviewerHints.map((hint, i) => (
                    <li key={i} className="wrap-anywhere">
                      {hint}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {verdict.signals.length > 0 ? <SlopSignals signals={verdict.signals} /> : null}

            {verdict.draftComment.trim() ? (
              <details>
                <summary className="dim cursor-pointer select-none">Draft comment</summary>
                <p className="dim mt-1.5">Posted by the comment / request-changes / close actions.</p>
                <div className="mt-1.5 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                  <Markdown text={verdict.draftComment} />
                </div>
              </details>
            ) : null}
          </>
        ) : d.status === 'running' ? (
          <PendingVerdict />
        ) : null}

        <footer className="dim flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-3 wrap-anywhere dark:border-zinc-800">
          <span title={new Date(d.createdAt).toLocaleString()}>Detected {timeAgo(d.createdAt)}</span>
          {d.runId ? (
            <span>
              Agent run{' '}
              <a className="linkish font-mono" href={`#/runs/${d.runId}`}>
                {d.runId}
              </a>
            </span>
          ) : null}
        </footer>
      </div>
    </Page>
  );
}

/**
 * Scoring in flight: the blocks the verdict will fill, drawn at the size they
 * will take. The PR, the contributor facts and the timings are already known
 * and stay real; only the agent's own output is a placeholder.
 */
function PendingVerdict(): JSX.Element {
  return (
    <>
      <InlineLoading label="Scoring this pull request against your rules. The verdict lands here when the run finishes." />
      <div>
        <Eyebrow>Verdict</Eyebrow>
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
      <div className="well">
        <Eyebrow>Suggestions for the author</Eyebrow>
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
      <SlopSignalsSkeleton />
    </>
  );
}
