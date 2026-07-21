import { useEffect, useState } from 'react';
import {
  ActionMenu,
  DetailGrid,
  DetailRow,
  Drawer,
  Dropdown,
  EmptyState,
  ErrorBar,
  Eyebrow,
  Field,
  FormActions,
  IconButton,
  InlineLoading,
  ListCard,
  ListFilterToolbar,
  Markdown,
  MetaSignal,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  SparkleIcon,
  Spinner,
  StatusDot,
  facet,
  timeAgo,
  useListFilter,
  type FilterSelectField,
  type StatusTone,
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

const STATUS_META: Record<SlopDetectionResult['status'], { label: string; tone: StatusTone }> = {
  running: { label: 'running', tone: 'blue' },
  pending: { label: 'pending review', tone: 'amber' },
  applied: { label: 'applied', tone: 'green' },
  dismissed: { label: 'dismissed', tone: 'zinc' },
  failed: { label: 'failed', tone: 'red' },
};

const STRENGTH_TONE: Record<SlopSignal['strength'], StatusTone> = {
  weak: 'zinc',
  moderate: 'amber',
  strong: 'red',
};

/**
 * The workspace's slop detections: a filterable list (RunsPage-style rows) and
 * a detail drawer with the full verdict + apply/dismiss actions. Detection is
 * review-then-apply — a verdict never touches GitHub until someone applies it
 * here (or a pipeline gates on the score).
 */
export default function Slop(): JSX.Element {
  const { current, detections, error, setError } = useSlopDetections();
  const { can } = useAuth();
  const [detecting, setDetecting] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const all = detections ?? [];
  const filterFields: Array<FilterSelectField<SlopDetectionResult>> = [
    {
      key: 'status',
      label: 'Status',
      allLabel: 'Any status',
      options: (Object.keys(STATUS_META) as Array<SlopDetectionResult['status']>).map((s) => ({
        value: s,
        label: STATUS_META[s].label,
      })),
      match: (d, v) => d.status === v,
    },
    {
      key: 'repo',
      label: 'Repository',
      allLabel: 'All repositories',
      options: facet(all, (d) => d.repo).map((r) => ({ value: r, label: r })),
      match: (d, v) => d.repo === v,
    },
  ];
  const filter = useListFilter(
    all,
    (d, needle) =>
      d.prTitle.toLowerCase().includes(needle) ||
      d.repo.toLowerCase().includes(needle) ||
      `${d.repo}#${d.prNumber}`.toLowerCase().includes(needle),
    filterFields,
  );

  if (!current) return <EmptyState title="No workspace selected" />;
  const canAct = can('slop:act');
  const detail = detailId ? (all.find((d) => d.id === detailId) ?? null) : null;

  const detectButton = (
    <button className="btn gap-1.5" onClick={() => setDetecting(true)}>
      <SparkleIcon className="size-3.5" />
      Detect
    </button>
  );

  return (
    <Page>
      <PageHeader
        title="Slop Detection"
        subtitle={`${current.name} — an agent scores pull requests against your rules; nothing touches GitHub until you apply a verdict`}
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
            {canAct ? detectButton : null}
          </div>
        }
      />
      <ErrorBar error={error} className="mb-3" />

      {detections === null ? (
        <PageLoading label="Loading detections…" />
      ) : all.length === 0 ? (
        <EmptyState
          title="No detections yet"
          hint="Point the detector at a pull request and an agent scores it against your workspace's rules — style tells, hallucinated APIs, diff-vs-description drift. Verdicts land here for review."
          action={canAct ? detectButton : undefined}
        />
      ) : (
        <>
          <ListFilterToolbar
            filter={filter}
            fields={filterFields}
            total={all.length}
            placeholder="Search PR title or repository…"
            searchLabel="Search detections"
          />
          {filter.filtered.length === 0 ? (
            <EmptyState title="No detections match" hint="Loosen the search or clear the filters." />
          ) : (
            <ListCard ariaLabel="Slop detections">
              {filter.filtered.map((d) => (
                <DetectionRow key={d.id} detection={d} onOpen={() => setDetailId(d.id)} />
              ))}
            </ListCard>
          )}
        </>
      )}

      {detecting ? <DetectModal workspaceId={current.id} onClose={() => setDetecting(false)} onError={setError} /> : null}
      {detail ? (
        <DetectionDrawer detection={detail} canAct={canAct} onClose={() => setDetailId(null)} onError={setError} />
      ) : null}
    </Page>
  );
}

function DetectionRow({ detection: d, onOpen }: { detection: SlopDetectionResult; onOpen: () => void }): JSX.Element {
  const meta = STATUS_META[d.status];
  const verdict = d.verdict;
  const detailBits = [
    meta.label,
    ...(verdict
      ? [
          `${verdict.confidence} confidence`,
          `recommends ${ACTION_LABEL[verdict.recommendedAction]}`,
          `${verdict.signals.length} signal${verdict.signals.length === 1 ? '' : 's'}`,
        ]
      : []),
    ...(d.appliedAction ? [`applied ${ACTION_LABEL[d.appliedAction]}`] : []),
    ...(d.status === 'failed' && d.error ? [d.error] : []),
    ...(d.status === 'running' ? ['the agent is reading the diff and rules'] : []),
  ];
  return (
    <button type="button" className="row-link w-full cursor-pointer text-left" onClick={onOpen}>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="dim shrink-0 font-mono text-xs">
            {d.repo}#{d.prNumber}
          </span>
          <span className="truncate font-medium">{d.prTitle}</span>
        </span>
        <span className="dim mt-0.5 block truncate text-xs">{detailBits.join(' · ')}</span>
      </span>
      {verdict ? <SlopMeter value={verdict.aiLikelihood} /> : null}
      <span className="dim shrink-0 text-xs tabular-nums" title={new Date(d.createdAt).toLocaleString()}>
        {timeAgo(d.createdAt)}
      </span>
      {d.status === 'running' ? <Spinner /> : <StatusDot tone={meta.tone} title={meta.label} />}
    </button>
  );
}

function DetectionDrawer({
  detection: d,
  canAct,
  onClose,
  onError,
}: {
  detection: SlopDetectionResult;
  canAct: boolean;
  onClose: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const verdict = d.verdict;
  const meta = STATUS_META[d.status];

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
    <Drawer
      title={`${d.repo}#${d.prNumber}`}
      onClose={onClose}
      storageKey="companion.slop.drawer.width"
      defaultWidth={560}
      minWidth={480}
    >
      <div className="flex flex-col gap-5">
        <div>
          <h3 className="text-base font-semibold">{d.prTitle}</h3>
          <DetailGrid className="mt-3">
            <DetailRow label="Pull request">
              <a className="linkish font-mono text-xs" href={`#/repos/${d.repo}/prs/${d.prNumber}`}>
                {d.repo}#{d.prNumber}
              </a>
            </DetailRow>
            <DetailRow label="Status">
              <MetaSignal tone={meta.tone} label={meta.label} pulse={d.status === 'running'} />
            </DetailRow>
            {verdict ? (
              <>
                <DetailRow label="Slop-o-meter">
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

        {canAct && d.status === 'pending' && verdict ? (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            {busy ? <Spinner /> : null}
            <button className="btn-ghost" disabled={busy} onClick={() => void act(() => slopApi.dismiss(d.id))}>
              Dismiss
            </button>
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
          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            {busy ? <Spinner /> : null}
            <button className="btn-ghost" disabled={busy} onClick={() => void act(() => slopApi.dismiss(d.id))}>
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    </Drawer>
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
    <Modal title="Run detection" onClose={onClose}>
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
        <Field
          label="Open pull request"
          hint="The agent reads the diff and the checkout, then scores it against the enabled rules. The detection appears in the list immediately and settles when the run finishes."
        >
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
