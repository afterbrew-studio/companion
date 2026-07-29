import { useCallback, useState } from 'react';
import {
  ActionMenu,
  Breadcrumb,
  DetailGrid,
  DetailRow,
  EmptyState,
  ErrorBar,
  Eyebrow,
  InlineLoading,
  Markdown,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Spinner,
} from '@moxxy/companion-sdk/ui';
import { useLive, type RouteProps } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { SlopDetectionResult } from '../../contract/index.js';
import { slopApi } from '../api.js';
import { SlopMeter } from '../components/SlopMeter.js';
import { ContributorProvenance } from '../components/ContributorProvenance.js';
import { ACTION_LABEL, STATUS_META, STRENGTH_TONE } from '../detection-meta.js';

/**
 * One detection in full: the verdict, every signal, the reviewer hints and the
 * draft comment, plus the apply/dismiss actions. Deep-linkable as #/slop/:id.
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
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:items-start">
          <div>
            <Eyebrow>Detection</Eyebrow>
            <DetailGrid className="mt-1.5">
              {verdict ? (
                <>
                  <DetailRow label="AI likelihood">
                    <SlopMeter value={verdict.aiLikelihood} />
                  </DetailRow>
                  <DetailRow label="Confidence">{verdict.confidence}</DetailRow>
                  <DetailRow label="Recommends">{ACTION_LABEL[verdict.recommendedAction]}</DetailRow>
                </>
              ) : null}
              {d.appliedAction ? <DetailRow label="Applied">{ACTION_LABEL[d.appliedAction]}</DetailRow> : null}
              {d.runId ? (
                <DetailRow label="Agent run">
                  <a className="linkish font-mono text-xs" href={`#/runs/${d.runId}`}>
                    {d.runId}
                  </a>
                </DetailRow>
              ) : null}
              <DetailRow label="Detected">{new Date(d.createdAt).toLocaleString()}</DetailRow>
            </DetailGrid>
          </div>

          <ContributorProvenance provenance={d.provenance} />
        </div>

        {d.status === 'running' ? (
          <InlineLoading label="The agent is scoring this pull request — the verdict lands here when it finishes." />
        ) : null}
        {d.status === 'failed' ? <p className="error-bar text-xs">{d.error ?? 'detection failed'}</p> : null}

        {verdict ? (
          <>
            <div>
              <Eyebrow>Verdict</Eyebrow>
              <p className="mt-1.5 text-sm">{verdict.summary}</p>
            </div>

            {verdict.signals.length > 0 ? (
              <div>
                <Eyebrow>Signals ({verdict.signals.length})</Eyebrow>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {verdict.signals.map((signal, i) => (
                    <li key={i} className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                      <MetaSignal
                        tone={STRENGTH_TONE[signal.strength]}
                        label={signal.ruleName}
                        title={`${signal.strength} signal`}
                      />
                      <p className="mt-1 text-[13px]">{signal.observation}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {verdict.reviewerHints.length > 0 ? (
              <div>
                <Eyebrow>Suggestions for the author</Eyebrow>
                <p className="dim mt-1 text-xs">
                  Relay these to the PR author — concrete asks that would clear the flagged signals.
                </p>
                <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px]">
                  {verdict.reviewerHints.map((hint, i) => (
                    <li key={i}>{hint}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {verdict.draftComment.trim() ? (
              <div>
                <Eyebrow>Draft comment</Eyebrow>
                <p className="dim mt-1 text-xs">Posted by the comment / request-changes / close actions.</p>
                <div className="mt-1.5 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                  <Markdown text={verdict.draftComment} />
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Page>
  );
}
