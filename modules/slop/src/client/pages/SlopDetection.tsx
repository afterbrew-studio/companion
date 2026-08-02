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
  Section,
  Skeleton,
  Spinner,
  timeAgo,
  useConfirm,
  type MenuAction,
} from '@moxxy/companion-sdk/ui';
import { useLive, type RouteProps } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { SlopAction, SlopDetectionResult } from '../../contract/index.js';
import { slopApi } from '../api.js';
import { ContributorProvenance } from '../components/ContributorProvenance.js';
import { PrQualityAssessment } from '../components/PrQualityAssessment.js';
import { SlopScore, SlopScoreSkeleton } from '../components/SlopScore.js';
import { SlopSignals, SlopSignalsSkeleton } from '../components/SlopSignals.js';
import { ACTION_BUTTON, ACTION_LABEL, STATUS_META } from '../detection-meta.js';

/**
 * One detection in full, ordered by what a maintainer decides with: the score
 * and the contributor facts side by side at the top, then the agent's reading,
 * then the evidence behind it. One titled section per block with room around it,
 * because this page is read, not scanned.
 *
 * The header holds two controls only: the recommended action, named so the
 * button says what it will do, and one menu for every other outcome (the other
 * GitHub actions, refinement, dismissal). Deep-linkable as #/slop/:id.
 */
export default function SlopDetection({ params }: RouteProps): JSX.Element {
  const id = params.id!;
  const { can } = useAuth();
  const { current } = useWorkspace();
  const { confirmDanger, confirmElement } = useConfirm();
  // undefined = loading, null = not found (or inaccessible, the same 404 either way).
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

  /**
   * Closing posts the draft comment and closes the pull request on GitHub: the
   * one outcome here Companion cannot take back, so it asks first.
   */
  const applyAction = async (action: SlopAction): Promise<void> => {
    if (action === 'close') {
      const ok = await confirmDanger({
        title: `Close ${d.repo}#${d.prNumber}`,
        message: 'The verdict is posted as a comment and the pull request is closed on GitHub.',
        confirmLabel: 'Close PR',
      });
      if (!ok) return;
    }
    await act(() => slopApi.apply(d.id, { action }));
  };

  const dismiss = (): void => void act(() => slopApi.dismiss(d.id));

  const actions =
    canAct && d.status === 'pending' && verdict ? (
      <div className="flex items-center gap-2">
        {busy ? <Spinner /> : null}
        <ActionMenu
          label="Other outcomes for this detection"
          actions={[
            ...(['label', 'comment', 'request_changes', 'close'] as const)
              .filter((a) => a !== verdict.recommendedAction)
              .map((action) => ({
                label: ACTION_BUTTON[action],
                danger: action === 'close',
                disabled: busy,
                onSelect: () => void applyAction(action),
              })),
            ...(canRefine && current
              ? [
                  {
                    label: 'Move to refinement',
                    disabled: busy,
                    onSelect: () =>
                      void act(async () => {
                        const { refinementId } = await slopApi.moveToRefinement(d.id, current.id);
                        window.location.hash = `/refinement/${refinementId}`;
                      }),
                  } satisfies MenuAction,
                ]
              : []),
            { label: 'Dismiss detection', disabled: busy, onSelect: dismiss },
          ]}
        />
        <button
          className="btn"
          disabled={busy}
          title={`The action the agent recommended: ${ACTION_LABEL[verdict.recommendedAction]}`}
          onClick={() => void applyAction(verdict.recommendedAction)}
        >
          {ACTION_BUTTON[verdict.recommendedAction]}
        </button>
      </div>
    ) : canAct && d.status === 'failed' ? (
      <div className="flex items-center gap-2">
        {busy ? <Spinner /> : null}
        <button className="btn-ghost" disabled={busy} onClick={dismiss}>
          Dismiss
        </button>
      </div>
    ) : undefined;

  return (
    <Page>
      {/* One measure for the whole page, header included: the actions line up
          with the panels' right edge instead of the page's, and the prose still
          wraps well short of it. The panels stretch to the taller of the two (no
          items-start): side by side, two card heights read as a slip. */}
      <div className="max-w-4xl">
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
        {confirmElement}

        <div className="grid gap-5 lg:grid-cols-2">
          {verdict ? (
            <SlopScore verdict={verdict} appliedAction={d.appliedAction} />
          ) : d.status === 'running' ? (
            <SlopScoreSkeleton />
          ) : (
            <div className="card">
              <Eyebrow>AI likelihood</Eyebrow>
              <p className="mt-2 text-sm">not scored</p>
            </div>
          )}
          <ContributorProvenance provenance={d.provenance} />
        </div>

        {verdict ? <PrQualityAssessment verdict={verdict} /> : null}

        {d.status === 'failed' ? (
          <p className="error-bar mt-5 text-xs wrap-anywhere">{d.error ?? 'detection failed'}</p>
        ) : null}

        {verdict ? (
          <>
            <Section title="Verdict">
              <p className="text-sm leading-relaxed wrap-anywhere">{verdict.summary}</p>
            </Section>

            {verdict.decisionFactors.length > 0 ? (
              <Section
                title="Decision factors"
                description="Positive, negative, and unknown evidence behind the quality classification."
              >
                <ul className="well flex flex-col divide-y divide-zinc-200 px-4 dark:divide-zinc-800">
                  {verdict.decisionFactors.map((factor, i) => (
                    <li key={i} className="flex gap-3 py-3 text-sm leading-relaxed">
                      <span
                        className={
                          factor.effect === 'positive'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : factor.effect === 'negative'
                              ? 'text-red-600 dark:text-red-400'
                              : 'dim'
                        }
                        aria-label={factor.effect}
                      >
                        {factor.effect === 'positive' ? '+' : factor.effect === 'negative' ? '−' : '·'}
                      </span>
                      <span className="min-w-0 wrap-anywhere">
                        <strong className="mr-1.5 text-xs uppercase tracking-wide">{factor.dimension}</strong>
                        {factor.observation}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {verdict.reviewerHints.length > 0 ? (
              <Section
                title="Suggestions for the author"
                description="Concrete asks that would raise the oversight bar on this pull request."
              >
                <ul className="well flex list-disc flex-col gap-2 p-4 pl-9 text-sm leading-relaxed">
                  {verdict.reviewerHints.map((hint, i) => (
                    <li key={i} className="wrap-anywhere">
                      {hint}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {verdict.signals.length > 0 ? (
              <Section
                title={`Signals (${verdict.signals.length})`}
                description="Which rules fired and how hard, strongest first. Open a row for the evidence behind it."
              >
                <SlopSignals signals={verdict.signals} />
              </Section>
            ) : null}

            {verdict.draftComment.trim() ? (
              // Collapsed: the longest block on the page, and it only matters
              // once you are about to post it. The summary matches a section
              // heading so the page keeps one hierarchy.
              <details className="mt-8">
                <summary className="cursor-pointer text-sm font-semibold select-none">Draft comment</summary>
                <p className="dim mt-2">Posted by the comment, request changes and close actions.</p>
                <div className="card mt-2.5">
                  <Markdown text={verdict.draftComment} />
                </div>
              </details>
            ) : null}
          </>
        ) : d.status === 'running' ? (
          <PendingVerdict />
        ) : null}

        <footer className="dim mt-8 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-200 pt-4 wrap-anywhere dark:border-zinc-800">
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
 * Scoring in flight: the sections the verdict will fill, drawn at the size they
 * will take. The PR, the contributor facts and the timings are already known
 * and stay real; only the agent's own output is a placeholder.
 */
function PendingVerdict(): JSX.Element {
  return (
    <>
      <InlineLoading
        className="mt-6"
        label="Scoring this pull request against your rules. The verdict lands here when the run finishes."
      />
      <Section title="Verdict">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </Section>
      <Section title="Suggestions for the author">
        <div className="well flex flex-col gap-2.5 p-4">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </Section>
      <Section title="Signals">
        <SlopSignalsSkeleton />
      </Section>
    </>
  );
}
