import { useEffect, useState } from 'react';
import {
  Dropdown,
  EmptyState,
  ErrorBar,
  Field,
  FilterField,
  FiltersPopover,
  FormActions,
  IconButton,
  ListCard,
  ListFooter,
  MetaSignal,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  SearchInput,
  SparkleIcon,
  Spinner,
  StatusDot,
  timeAgo,
  useHashFilters,
  useHashSearch,
} from '@moxxy/companion-sdk/ui';
import { NavIcon } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspaceRepos, codeApi } from '@companion/module-code/client';
import type { PrQualityClass, SlopDetectionResult } from '../../contract/index.js';
import { slopApi } from '../api.js';
import { SlopMeter } from '../components/SlopMeter.js';
import { QUALITY_META } from '../components/PrQualityAssessment.js';
import { ACTION_LABEL, STATUS_META } from '../detection-meta.js';
import { useSlopDetections } from '../hooks/useSlopDetections.js';

/**
 * The workspace's slop detections: a filterable list (RunsPage-style rows);
 * each row links to the detection's own page (#/slop/:id) with the full
 * verdict + apply/dismiss actions. Detection is review-then-apply: a verdict
 * never touches GitHub until someone applies it there (or a pipeline gates on
 * the score).
 */
export default function Slop(): JSX.Element {
  const { filters, setFilter, clearFilters, activeFilters } = useHashFilters(['status', 'repo', 'quality'] as const);
  const { search, setSearch, q } = useHashSearch();
  const { current, detections, total, loading, hasMore, loadMore, error, setError, refresh } = useSlopDetections({
    q: q || undefined,
    status: filters.status === 'all' ? undefined : filters.status,
    repo: filters.repo === 'all' ? undefined : filters.repo,
    quality: filters.quality === 'all' ? undefined : filters.quality,
  });
  const { can } = useAuth();
  const [detecting, setDetecting] = useState(false);
  const repos = useWorkspaceRepos(current?.id);

  const all = detections ?? [];

  if (!current) return <EmptyState title="No workspace selected" />;
  const canAct = can('slop:act');

  const detectButton = (
    <button className="btn gap-1.5" onClick={() => setDetecting(true)}>
      <SparkleIcon className="size-3.5" />
      Detect
    </button>
  );

  return (
    <Page>
      <PageHeader
        title="Contribution Quality"
        subtitle={`${current.name}: assess value, evidence, risk and reviewability; provenance never decides quality by itself`}
        actions={
          <div className="flex items-center gap-1.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search assessments…  ( / )"
              ariaLabel="Search contribution assessments"
            />
            <FiltersPopover active={activeFilters} onClear={clearFilters}>
              <FilterField label="Status">
                <Dropdown
                  ariaLabel="Filter assessments by status"
                  value={filters.status}
                  onChange={setFilter('status')}
                  options={[
                    { value: 'all', label: 'Any status' },
                    ...(Object.keys(STATUS_META) as Array<SlopDetectionResult['status']>).map((status) => ({
                      value: status,
                      label: STATUS_META[status].label,
                    })),
                  ]}
                />
              </FilterField>
              {repos.length > 1 ? (
                <FilterField label="Repository">
                  <Dropdown
                    ariaLabel="Filter assessments by repository"
                    value={filters.repo}
                    onChange={setFilter('repo')}
                    searchable
                    options={[
                      { value: 'all', label: 'All repositories' },
                      ...repos.map((repo) => ({ value: repo.fullName, label: repo.fullName })),
                    ]}
                  />
                </FilterField>
              ) : null}
              <FilterField label="PR quality">
                <Dropdown
                  ariaLabel="Filter assessments by PR quality"
                  value={filters.quality}
                  onChange={setFilter('quality')}
                  options={[
                    { value: 'all', label: 'Any quality' },
                    ...(Object.keys(QUALITY_META) as PrQualityClass[]).map((quality) => ({
                      value: quality,
                      label: QUALITY_META[quality].label,
                    })),
                  ]}
                />
              </FilterField>
            </FiltersPopover>
            {can('slop:manage') ? (
              <IconButton
                label="Detection rules"
                className="flex size-9 items-center justify-center"
                onClick={() => (window.location.hash = '/slop/rules')}
              >
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
      ) : error && all.length === 0 ? (
        <EmptyState
          title="Could not load contribution assessments"
          hint="The previous queue remains untouched. Retry when the service is reachable."
          action={<button className="btn" onClick={() => void refresh()}>Retry</button>}
        />
      ) : all.length === 0 && activeFilters === 0 && !search.trim() ? (
        <EmptyState
          title="No detections yet"
          hint="Point the assessor at a pull request. It separates contribution quality from authorship, then leaves every action for human review."
          action={canAct ? detectButton : undefined}
        />
      ) : all.length === 0 ? (
        <EmptyState title="No assessments match" hint="Loosen the search or clear the filters." />
      ) : (
        <ListCard ariaLabel="Contribution assessments">
          {all.map((d) => (
            <DetectionRow key={d.id} detection={d} />
          ))}
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={all.length}
            total={total}
            noun="assessments"
            onVisible={loadMore}
          />
        </ListCard>
      )}

      {detecting ? <DetectModal workspaceId={current.id} onClose={() => setDetecting(false)} onError={setError} /> : null}
    </Page>
  );
}

function DetectionRow({ detection: d }: { detection: SlopDetectionResult }): JSX.Element {
  const meta = STATUS_META[d.status];
  const verdict = d.verdict;
  const detailBits = [
    meta.label,
    ...(verdict
      ? [
          `${verdict.confidence} confidence`,
          QUALITY_META[verdict.qualityClass].label,
          `${verdict.testEvidence} test evidence`,
          `recommends ${ACTION_LABEL[verdict.recommendedAction]}`,
          `${verdict.signals.length} signal${verdict.signals.length === 1 ? '' : 's'}`,
        ]
      : []),
    ...(d.appliedAction ? [`applied ${ACTION_LABEL[d.appliedAction]}`] : []),
    ...(d.status === 'failed' && d.error ? [d.error] : []),
    ...(d.status === 'running' ? ['the agent is reading the diff and rules'] : []),
  ];
  return (
    <a className="row-link" href={`#/slop/${d.id}`}>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="dim shrink-0 font-mono text-xs">
            {d.repo}#{d.prNumber}
          </span>
          <span className="truncate font-medium">{d.prTitle}</span>
        </span>
        <span className="dim mt-0.5 block truncate text-xs">{detailBits.join(' · ')}</span>
      </span>
      {verdict ? (
        <span className="flex shrink-0 items-center gap-2">
          <MetaSignal tone={QUALITY_META[verdict.qualityClass].tone} label={QUALITY_META[verdict.qualityClass].label} />
          <SlopMeter value={verdict.aiLikelihood} />
        </span>
      ) : null}
      <span className="dim shrink-0 text-xs tabular-nums" title={new Date(d.createdAt).toLocaleString()}>
        {timeAgo(d.createdAt)}
      </span>
      {d.status === 'running' ? <Spinner /> : <StatusDot tone={meta.tone} title={meta.label} />}
    </a>
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

  // Picking a repo loads its open PRs (cache reads, cheap).
  useEffect(() => {
    if (!effectiveRepo) return;
    let cancelled = false;
    void codeApi
      .workspacePrs(workspaceId, 'open', { repo: effectiveRepo, limit: 100 })
      .then(({ prs }) => {
        if (cancelled) return;
        setPrs(prs.map((pr) => ({ number: pr.number, title: pr.title })));
        setPrNumber(null);
      })
      .catch(() => setPrs([]));
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo, workspaceId]);

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
              options={prs.map((pr) => ({ value: String(pr.number), label: `#${pr.number} · ${pr.title}` }))}
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
