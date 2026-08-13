import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import { onServerMessage, readCached, request, useLive, useModuleEnabled, writeCached } from '@moxxy/companion-sdk/client';
import { operateApi } from '@companion/module-operate/client';
import type { RunListRecord } from '@companion/module-operate/contract';
import { useWorkspace, workspaceApi } from '@companion/module-workspace/client';
import type { ReportRecord, WeeklyCounts, WorkspaceMetrics } from '@companion/module-workspace/contract';
import type { IssueListRecord, PipelineRunRecord, PrListRecord, RepoRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * FLAG: proposals belong to module-plan, which depends on code — importing its
 * api/contract here would be a cycle. The Overview only shows a shallow
 * "needs a human" slice, so the shape is structural (the fields the dashboard
 * renders) and the fetch shares only the URL, mirroring workspaceApi's
 * digestNow precedent. Keep in sync with plan's `/api/workspaces/:id/proposals`
 * route and its `proposals.changed` message.
 */
export interface OverviewProposal {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: number;
}

const workspaceProposals = (id: string): Promise<{ proposals: OverviewProposal[] }> =>
  request<{ proposals: OverviewProposal[] }>(`/api/workspaces/${id}/proposals`);

/** A stat's trailing delta, for the tile arrow. */
interface Delta {
  readonly current: number;
  readonly previous: number;
  readonly period: string;
  readonly upIsGood: boolean;
}

/**
 * All of the workspace Overview's data — the raw feeds, the live refresh, and
 * every derived "needs a human" queue and backlog trend. A first visit fills
 * each independent feed as it lands; revisits paint the last auth-scoped
 * snapshot immediately and revalidate it in the background. The page is pure
 * presentation over this.
 */
export interface UseOverview {
  readonly hasWorkspace: boolean;
  readonly workspaceName: string;
  readonly error: string | null;

  readonly repos: RepoRecord[] | null;
  readonly metrics: WorkspaceMetrics | null;
  /** Runs and reports already scoped to this workspace's repos (or instance-wide). */
  readonly workspaceRuns: RunListRecord[] | null;
  readonly workspaceReports: ReportRecord[] | null;
  readonly pipelineRuns: PipelineRunRecord[] | null;

  readonly openIssueCount: number | null;
  readonly openPrCount: number | null;
  readonly openPrs: PrListRecord[] | null;
  readonly failingPrs: PrListRecord[] | null;
  readonly liveRuns: RunListRecord[] | null;
  readonly reviewRuns: RunListRecord[] | null;
  readonly actionableProposals: OverviewProposal[] | null;
  readonly prReviewsPending: PrListRecord[] | null;
  readonly triagePending: IssueListRecord[] | null;
  /** Null while any of the attention feeds is still loading. */
  readonly attentionCount: number | null;

  readonly issueBacklog: number[] | null;
  readonly prBacklog: number[] | null;
  readonly issueBacklogDelta: Delta | undefined;
  readonly prBacklogDelta: Delta | undefined;
}

// Stable fetchers (useFeed keys its refresh on identity — an inline arrow
// would refetch every render). Reports stay best-effort, as before.
const fetchOpenIssues = (id: string): Promise<{ total: number }> =>
  api.workspaceIssues(id, 'open', { limit: 1 }).then((r) => ({ total: r.total }));
const fetchPrs = (id: string): Promise<{ prs: PrListRecord[]; total: number }> =>
  api.workspacePrs(id, 'open', { limit: 100 }).then((r) => ({ prs: r.prs, total: r.total }));
const fetchProposals = (id: string): Promise<OverviewProposal[]> => workspaceProposals(id).then((r) => r.proposals);
interface OverviewRunFeed {
  readonly recent: RunListRecord[];
  readonly active: RunListRecord[];
  readonly review: RunListRecord[];
  readonly reviewTotal: number;
}
const fetchRuns = async (id: string): Promise<OverviewRunFeed> => {
  // Filter before bounding: a long terminal history must not hide live work or
  // under-count the queue awaiting maintainer review.
  const [recent, active, review] = await Promise.all([
    operateApi.listRunsPage({ workspace: id, limit: 100 }),
    operateApi.listRunsPage({ workspace: id, status: 'active', limit: 100 }),
    operateApi.listRunsPage({ workspace: id, status: 'review', limit: 100 }),
  ]);
  return { recent: recent.runs, active: active.runs, review: review.runs, reviewTotal: review.total };
};
const fetchPipelineRuns = (id: string): Promise<PipelineRunRecord[]> => api.workspacePipelineRuns(id).then((r) => r.runs);
const fetchRepos = (id: string): Promise<RepoRecord[]> => api.workspaceRepos(id).then((r) => r.repos);
const fetchMetrics = (id: string): Promise<WorkspaceMetrics> => workspaceApi.workspaceMetrics(id).then((r) => r.metrics);
const fetchReports = (): Promise<ReportRecord[]> =>
  workspaceApi
    .listReports()
    .then((r) => r.reports)
    .catch(() => []);
const fetchPendingReviews = (id: string): Promise<PrListRecord[]> =>
  api.workspacePrs(id, 'open', { review: 'pending', limit: 50 }).then((r) => r.prs);
const fetchPendingTriage = (id: string): Promise<IssueListRecord[]> =>
  api.workspaceIssues(id, 'open', { triage: 'pending', limit: 50 }).then((r) => r.issues);

/**
 * One Overview feed: loads on mount, refetches on its matching WS messages,
 * `data` is null until the first response (and again on workspace switch).
 */
function useFeed<T>(
  id: string | null,
  name: string,
  fetcher: (ws: string) => Promise<T>,
  when: (msg: SpaServerMessage) => boolean,
): {
  data: T | null;
  error: string | null;
  patch: (update: (current: T) => T) => void;
} {
  const cacheKey = id === null ? null : `overview:${id}:${name}`;
  const [snapshot, setSnapshot] = useState<{
    readonly key: string | null;
    readonly data: T | null;
    readonly error: string | null;
  }>(() => ({
    key: cacheKey,
    data: cacheKey === null ? null : readCached<T>(cacheKey),
    error: null,
  }));
  const requestSequence = useRef(0);
  // A revisit paints the last truthful snapshot while the live feed quietly
  // revalidates it. A different workspace can only use its own retained copy.
  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot({
      key: cacheKey,
      data: cacheKey === null ? null : readCached<T>(cacheKey),
      error: null,
    });
  }, [cacheKey]);
  const refresh = useCallback(async () => {
    if (!id || cacheKey === null) return;
    const requestId = ++requestSequence.current;
    try {
      const next = await fetcher(id);
      if (requestId !== requestSequence.current) return;
      writeCached(cacheKey, next);
      setSnapshot({ key: cacheKey, data: next, error: null });
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      setSnapshot((current) => ({
        key: cacheKey,
        data: current.key === cacheKey ? current.data : readCached<T>(cacheKey),
        error: String(err),
      }));
    }
  }, [id, cacheKey, fetcher]);
  useLive(refresh, when);
  const patch = useCallback((update: (current: T) => T): void => {
    setSnapshot((current) => {
      if (current.key !== cacheKey || current.data === null) return current;
      const next = update(current.data);
      if (cacheKey !== null) writeCached(cacheKey, next);
      return { ...current, data: next };
    });
  }, [cacheKey]);
  const visible = snapshot.key === cacheKey
    ? snapshot
    : {
        key: cacheKey,
        data: cacheKey === null ? null : readCached<T>(cacheKey),
        error: null,
      };
  return { data: visible.data, error: visible.error, patch };
}

export function useOverview(): UseOverview {
  const { current } = useWorkspace();
  const id = current?.id ?? null;

  // Ten independent feeds, each with a precise refresh predicate — a
  // reports.changed no longer refetches issues, and a slow metrics query
  // never holds back the queues.
  const issues = useFeed(id, 'issues', fetchOpenIssues, (m) => m.t === 'issues.changed' || m.t === 'triage.changed');
  const prs = useFeed(id, 'prs', fetchPrs, (m) => m.t === 'prs.changed');
  // FLAG: plan's message literal — not in code's visible union (plan depends on us).
  // Optional cross-module read: plan owns this route and may not be in the
  // build, installed, or enabled. Skipping the fetch is the fix; catching the
  // 404 afterwards would hide a real one.
  const planEnabled = useModuleEnabled('plan');
  const proposals = useFeed(planEnabled ? id : null, 'proposals', fetchProposals, (m) => (m.t as string) === 'proposals.changed');
  const runs = useFeed(id, 'runs', fetchRuns, (m) => m.t === 'runs.changed' || m.t === 'run.changed');
  const pipelineRuns = useFeed(id, 'pipeline-runs', fetchPipelineRuns, (m) => m.t === 'pipelineRuns.changed');
  const repos = useFeed(id, 'repos', fetchRepos, (m) => m.t === 'repos.changed');
  const metrics = useFeed(
    id,
    'metrics',
    fetchMetrics,
    (m) => m.t === 'issues.changed' || m.t === 'prs.changed' || m.t === 'repos.changed',
  );
  const reports = useFeed(id, 'reports', fetchReports, (m) => m.t === 'reports.changed');
  const pendingReviews = useFeed(id, 'pending-reviews', fetchPendingReviews, (m) => m.t === 'prs.changed');
  const pendingTriage = useFeed(id, 'pending-triage', fetchPendingTriage, (m) => m.t === 'triage.changed' || m.t === 'issues.changed');

  // CI/review warm-up can land dozens of snapshots in quick succession. Fold
  // each one into the already loaded Overview feed instead of refetching the
  // same 100-row window for every status event.
  useEffect(() => onServerMessage((msg) => {
    if (msg.t !== 'prStatus.changed') return;
    prs.patch((current) => ({
      ...current,
      prs: current.prs.map((pr) =>
        pr.repo === msg.repo && pr.number === msg.number ? { ...pr, ...msg.status } : pr,
      ),
    }));
  }), [prs.patch]);

  const error =
    issues.error ??
    prs.error ??
    proposals.error ??
    runs.error ??
    pipelineRuns.error ??
    repos.error ??
    metrics.error ??
    pendingReviews.error ??
    pendingTriage.error ??
    null;

  // Workspace scoping needs the repo list — run-derived slices hold until both landed.
  const wsRepoNames = repos.data ? new Set(repos.data.map((r) => r.fullName)) : null;
  const inWorkspace = (repo: string | null): boolean => repo === null || (wsRepoNames?.has(repo) ?? false);
  const scopedRuns = runs.data && wsRepoNames ? runs.data.recent.filter((r) => inWorkspace(r.repo)) : null;
  const scopedActiveRuns = runs.data && wsRepoNames ? runs.data.active.filter((r) => inWorkspace(r.repo)) : null;
  const openPrs = prs.data?.prs ?? null;
  const failingPrs = openPrs?.filter((p) => p.checks?.state === 'failing') ?? null;
  const liveRuns = scopedActiveRuns?.filter((r) => r.live) ?? null;
  const reviewRuns = runs.data && wsRepoNames ? runs.data.review.filter((r) => inWorkspace(r.repo)) : null;
  const reviewRunTotal = runs.data?.reviewTotal ?? null;
  // Without plan there are no proposals to wait for, so an empty list rather
  // than `null`: a permanently-loading tile would be its own bug.
  const actionableProposals = planEnabled
    ? (proposals.data?.filter((p) => p.status === 'analyzed' || p.status === 'review') ?? null)
    : [];
  const attentionCount =
    reviewRunTotal !== null && pendingReviews.data && pendingTriage.data && failingPrs && actionableProposals
      ? reviewRunTotal +
        pendingReviews.data.length +
        pendingTriage.data.length +
        failingPrs.length +
        actionableProposals.length
      : null;

  const issueBacklog =
    metrics.data && issues.data
      ? backlogTrend(metrics.data.weekly, issues.data.total, (w) => w.issuesOpened, (w) => w.issuesClosed)
      : null;
  const prBacklog =
    metrics.data && prs.data
      ? backlogTrend(metrics.data.weekly, prs.data.total, (w) => w.prsOpened, (w) => w.prsClosed)
      : null;
  const issueBacklogDelta =
    metrics.data && issues.data
      ? {
          current: issues.data.total,
          previous: Math.max(0, issues.data.total - (metrics.data.issuesOpened7d - metrics.data.issuesClosed7d)),
          period: 'vs 7 days ago',
          upIsGood: false,
        }
      : undefined;
  const prBacklogDelta =
    metrics.data && prs.data
      ? {
          current: prs.data.total,
          previous: Math.max(0, prs.data.total - (metrics.data.prsOpened7d - metrics.data.prsClosed7d)),
          period: 'vs 7 days ago',
          upIsGood: false,
        }
      : undefined;

  return {
    hasWorkspace: !!current,
    workspaceName: current?.name ?? '',
    error,
    repos: repos.data,
    metrics: metrics.data,
    workspaceRuns: scopedRuns,
    workspaceReports: reports.data && wsRepoNames ? reports.data.filter((r) => inWorkspace(r.repo)) : null,
    pipelineRuns: pipelineRuns.data,
    openIssueCount: issues.data?.total ?? null,
    openPrCount: prs.data?.total ?? null,
    openPrs,
    failingPrs,
    liveRuns,
    reviewRuns,
    actionableProposals,
    prReviewsPending: pendingReviews.data,
    triagePending: pendingTriage.data,
    attentionCount,
    issueBacklog,
    prBacklog,
    issueBacklogDelta,
    prBacklogDelta,
  };
}

/** Backlog trend reconstructed from weekly nets (current value, walking back). */
function backlogTrend(
  weekly: ReadonlyArray<WeeklyCounts>,
  openNow: number,
  opened: (w: WeeklyCounts) => number,
  closed: (w: WeeklyCounts) => number,
): number[] {
  const out: number[] = new Array<number>(weekly.length);
  let v = openNow;
  for (let i = weekly.length - 1; i >= 0; i--) {
    out[i] = Math.max(0, v);
    v -= opened(weekly[i]!) - closed(weekly[i]!);
  }
  return out;
}
