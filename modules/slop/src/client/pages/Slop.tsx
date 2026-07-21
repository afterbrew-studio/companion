import { useEffect, useState } from 'react';
import {
  ActionMenu,
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  SparkleIcon,
  Spinner,
  timeAgo,
} from '@companion/ui';
import { NavIcon } from '@companion/core/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspaceRepos, codeApi } from '@companion/module-code/client';
import type { SlopAction, SlopDetectionResult, SlopSignal } from '../../contract/index.js';
import { slopApi } from '../api.js';
import { SlopMeter } from '../components/SlopMeter.js';
import { useSlopDetections } from '../hooks/useSlopDetections.js';

const ACTION_LABEL: Record<SlopAction, string> = {
  none: 'nothing',
  label: 'apply label',
  comment: 'comment',
  request_changes: 'request changes',
  close: 'close PR',
};

/**
 * The workspace's slop detections: verdicts pending review, with apply/dismiss
 * actions. Detection is review-then-apply — a verdict never touches GitHub
 * until someone picks an action here (or a pipeline gates on the score).
 */
export default function Slop(): JSX.Element {
  const { current, detections, error, setError } = useSlopDetections();
  const { can } = useAuth();
  const [detecting, setDetecting] = useState(false);

  if (!current) return <EmptyState title="No workspace selected" />;
  const canAct = can('slop:act');

  return (
    <Page>
      <PageHeader
        title="AI Slop Detection"
        subtitle={current.name}
        actions={
          <div className="flex items-center gap-1.5">
            {can('slop:manage') ? (
              <IconButton label="Detection rules" onClick={() => (window.location.hash = '/slop/rules')}>
                <NavIcon>
                  <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                  <circle cx="16" cy="7" r="2" />
                  <circle cx="8" cy="17" r="2" />
                </NavIcon>
              </IconButton>
            ) : null}
            {canAct ? (
              <button className="btn gap-1.5" onClick={() => setDetecting(true)}>
                <SparkleIcon className="size-3.5" />
                Detect
              </button>
            ) : undefined}
          </div>
        }
      />
      <ErrorBar error={error} className="mb-3" />

      {detections === null ? (
        <PageLoading label="Loading detections…" />
      ) : detections.length === 0 ? (
        <EmptyState
          title="No detections yet"
          hint="Point the detector at a pull request and an agent scores it against your workspace's rules — style tells, hallucinated APIs, diff-vs-description drift. Verdicts land here for review; nothing touches GitHub until you apply one."
          action={
            canAct ? (
              <button className="btn gap-1.5" onClick={() => setDetecting(true)}>
                <SparkleIcon className="size-3.5" />
                Detect
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {detections.map((d) => (
            <DetectionCard key={d.id} detection={d} canAct={canAct} onError={setError} />
          ))}
        </div>
      )}

      {detecting ? <DetectModal workspaceId={current.id} onClose={() => setDetecting(false)} onError={setError} /> : null}
    </Page>
  );
}

function StatusBadge({ status }: { status: SlopDetectionResult['status'] }): JSX.Element {
  switch (status) {
    case 'pending':
      return <span className="badge-accent">pending review</span>;
    case 'applied':
      return <span className="badge-ok">applied</span>;
    case 'dismissed':
      return <span className="badge opacity-70">dismissed</span>;
    case 'failed':
      return <span className="badge-danger">failed</span>;
  }
}

const STRENGTH_DOT: Record<SlopSignal['strength'], string> = {
  weak: 'bg-zinc-400 dark:bg-zinc-600',
  moderate: 'bg-amber-500 dark:bg-amber-400',
  strong: 'bg-red-500 dark:bg-red-400',
};

function DetectionCard({
  detection,
  canAct,
  onError,
}: {
  detection: SlopDetectionResult;
  canAct: boolean;
  onError: (e: string | null) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const verdict = detection.verdict;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      onError(null);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="row-link min-w-0 truncate font-mono text-xs"
          href={`#/repos/${detection.repo}/prs/${detection.prNumber}`}
        >
          {detection.repo}#{detection.prNumber}
        </a>
        <h2 className="min-w-0 truncate text-sm font-medium">{detection.prTitle}</h2>
        <StatusBadge status={detection.status} />
        {verdict ? <SlopMeter value={verdict.aiLikelihood} /> : null}
        <span className="flex-1" />
        <span className="dim text-xs tabular-nums">{timeAgo(detection.createdAt)}</span>
        {busy ? <Spinner /> : null}
        {canAct && detection.status === 'pending' && verdict ? (
          <ActionMenu
            actions={[
              {
                label: `Apply recommended — ${ACTION_LABEL[verdict.recommendedAction]}`,
                onSelect: () => void act(() => slopApi.apply(detection.id, {})),
              },
              ...(['label', 'comment', 'request_changes'] as const)
                .filter((a) => a !== verdict.recommendedAction)
                .map((action) => ({
                  label: `Apply — ${ACTION_LABEL[action]}`,
                  onSelect: () => void act(() => slopApi.apply(detection.id, { action })),
                })),
              ...(verdict.recommendedAction !== 'close'
                ? [
                    {
                      label: 'Apply — close PR',
                      danger: true,
                      onSelect: () => void act(() => slopApi.apply(detection.id, { action: 'close' })),
                    },
                  ]
                : []),
              { label: 'Dismiss', onSelect: () => void act(() => slopApi.dismiss(detection.id)) },
            ]}
          />
        ) : null}
      </div>

      {verdict ? (
        <>
          <p className="mt-2 text-sm">
            {verdict.summary}{' '}
            <span className="dim text-xs">
              ({verdict.confidence} confidence · recommends {ACTION_LABEL[verdict.recommendedAction]}
              {detection.appliedAction ? ` · applied ${ACTION_LABEL[detection.appliedAction]}` : ''})
            </span>
          </p>
          {verdict.signals.length > 0 ? (
            <div className="mt-2">
              <button className="dim cursor-pointer text-xs hover:underline" onClick={() => setExpanded((e) => !e)}>
                {expanded ? 'Hide' : 'Show'} {verdict.signals.length} signal{verdict.signals.length === 1 ? '' : 's'}
              </button>
              {expanded ? (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {verdict.signals.map((signal, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-xs">
                      <span
                        className={`mt-0.5 size-1.5 shrink-0 self-center rounded-full ${STRENGTH_DOT[signal.strength]}`}
                        title={signal.strength}
                      />
                      <span className="dim shrink-0">{signal.ruleName}</span>
                      <span className="min-w-0">{signal.observation}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="error-bar mt-2 text-xs">{detection.error ?? 'detection failed'}</p>
      )}
    </div>
  );
}

function DetectModal({
  workspaceId,
  onClose,
  onError,
}: {
  workspaceId: string;
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const repos = useWorkspaceRepos(workspaceId);
  const [repo, setRepo] = useState<string | null>(null);
  const [prs, setPrs] = useState<Array<{ number: number; title: string }>>([]);
  const [prNumber, setPrNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveRepo = repo ?? repos[0]?.fullName ?? null;

  // Picking a repo loads its open PRs (cache reads — cheap).
  useEffect(() => {
    if (!effectiveRepo) return;
    let cancelled = false;
    void codeApi
      .listPrs(effectiveRepo)
      .then(({ prs }) => {
        if (cancelled) return;
        setPrs(prs.filter((pr) => pr.state === 'open').map((pr) => ({ number: pr.number, title: pr.title })));
        setPrNumber(null);
      })
      .catch(() => setPrs([]));
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo]);

  const effectivePr = prNumber ?? (prs[0] ? String(prs[0].number) : null);

  const submit = async (): Promise<void> => {
    if (!effectiveRepo || !effectivePr) return;
    setBusy(true);
    try {
      await slopApi.detect(effectiveRepo, Number(effectivePr));
      onError(null);
      onClose();
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Detect AI slop" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Repository">
          <Dropdown
            ariaLabel="Repository"
            value={effectiveRepo}
            onChange={(v) => setRepo(v)}
            options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))}
            searchable
          />
        </Field>
        <Field label="Open pull request" hint="The agent reads the diff and the checkout, then scores it against the enabled rules.">
          {prs.length === 0 ? (
            <p className="dim text-sm">No open PRs in this repository.</p>
          ) : (
            <Dropdown
              ariaLabel="Pull request"
              value={effectivePr}
              onChange={(v) => setPrNumber(v)}
              options={prs.map((pr) => ({ value: String(pr.number), label: `#${pr.number} — ${pr.title}` }))}
              searchable
            />
          )}
        </Field>
        <FormActions>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn gap-1.5" disabled={busy || !effectiveRepo || !effectivePr} onClick={() => void submit()}>
            <SparkleIcon className="size-3.5" />
            {busy ? 'Queuing…' : 'Run detection'}
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}
