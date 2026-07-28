import { useCallback, useEffect, useState } from 'react';
import type { SpaServerMessage } from '@moxxy/companion-sdk';
import { request, useLive, useModuleEnabled } from '@moxxy/companion-sdk/client';
import { operateApi } from '@companion/module-operate/client';
import type { RunRecord } from '@companion/module-operate/contract';
import { useWorkspace, workspaceApi } from '@companion/module-workspace/client';
import type { ReportRecord, WeeklyCounts, WorkspaceMetrics } from '@companion/module-workspace/contract';
import type { IssueRecord, PipelineRunRecord, PrRecord, RepoRecord } from '../../contract/index.js';
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
 * every derived "needs a human" queue and backlog trend. Every feed is `null`
 * until its own request lands, so the page renders per-section loaders and
 * fills in as responses arrive instead of popping in whole once the slowest
 * request resolves. The page is pure presentation over this.
 */
export interface UseOverview {
  readonly hasWorkspace: boolean;
  readonly workspaceName: string;
  readonly error: string | null;

  readonly repos: RepoRecord[] | null;
  readonly metrics: WorkspaceMetrics | null;
  /** Runs and reports already scoped to this workspace's repos (or instance-wide). */
  readonly workspaceRuns: RunRecord[] | null;
  readonly workspaceReports: ReportRecord[] | null;
  readonly pipelineRuns: PipelineRunRecord[] | null;

  readonly openIssueCount: number | null;
  readonly openPrs: PrRecord[] | null;
  readonly failingPrs: PrRecord[] | null;
  readonly liveRuns: RunRecord[] | null;
  readonly reviewRuns: RunRecord[] | null;
  readonly actionableProposals: OverviewProposal[] | null;
  readonly prReviewsPending: PrRecord[] | null;
  readonly triagePending: IssueRecord[] | null;
  /** Null while any of the attention feeds is still loading. */
  readonly attentionCount: number | null;

  readonly issueBacklog: number[] | null;
  readonly prBacklog: number[] | null;
  readonly issueBacklogDelta: Delta | undefined;
  readonly prBacklogDelta: Delta | undefined;
}

// Stable fetchers (useFeed keys its refresh on identity — an inline arrow
// would refetch every render). Reports stay best-effort, as before.
const fetchOpenIssues = (id: string): Promise<IssueRecord[]> => api.workspaceIssues(id, 'open').then((r) => r.issues);
const fetchPrs = (id: string): Promise<PrRecord[]> => api.workspacePrs(id).then((r) => r.prs);
const fetchProposals = (id: string): Promise<OverviewProposal[]> => workspaceProposals(id).then((r) => r.proposals);
const fetchRuns = (): Promise<RunRecord[]> => operateApi.listRuns().then((r) => r.runs);
const fetchPipelineRuns = (id: string): Promise<PipelineRunRecord[]> => api.workspacePipelineRuns(id).then((r) => r.runs);
const fetchRepos = (id: string): Promise<RepoRecord[]> => api.workspaceRepos(id).then((r) => r.repos);
const fetchMetrics = (id: string): Promise<WorkspaceMetrics> => workspaceApi.workspaceMetrics(id).then((r) => r.metrics);
const fetchReports = (): Promise<ReportRecord[]> =>
  workspaceApi
    .listReports()
    .then((r) => r.reports)
    .catch(() => []);
const fetchPendingReviews = (id: string): Promise<PrRecord[]> =>
  api.workspacePrs(id, 'open', { review: 'pending', limit: 50 }).then((r) => r.prs);
const fetchPendingTriage = (id: string): Promise<IssueRecord[]> =>
  api.workspaceIssues(id, 'open', { triage: 'pending', limit: 50 }).then((r) => r.issues);

/**
 * One Overview feed: loads on mount, refetches on its matching WS messages,
 * `data` is null until the first response (and again on workspace switch).
 */
function useFeed<T>(
  id: string | null,
  fetcher: (ws: string) => Promise<T>,
  when: (msg: SpaServerMessage) => boolean,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Workspace switch: back to the loader.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [id]);
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setData(await fetcher(id));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [id, fetcher]);
  useLive(refresh, when);
  return { data, error };
}

export function useOverview(): UseOverview {
  const { current } = useWorkspace();
  const id = current?.id ?? null;

  // Ten independent feeds, each with a precise refresh predicate — a
  // reports.changed no longer refetches issues, and a slow metrics query
  // never holds back the queues.
  const issues = useFeed(id, fetchOpenIssues, (m) => m.t === 'issues.changed' || m.t === 'triage.changed');
  const prs = useFeed(id, fetchPrs, (m) => m.t === 'prs.changed');
  // FLAG: plan's message literal — not in code's visible union (plan depends on us).
  // Optional cross-module read: plan owns this route and may not be in the
  // build, installed, or enabled. Skipping the fetch is the fix; catching the
  // 404 afterwards would hide a real one.
  const planEnabled = useModuleEnabled('plan');
  const proposals = useFeed(planEnabled ? id : null, fetchProposals, (m) => (m.t as string) === 'proposals.changed');
  const runs = useFeed(id, fetchRuns, (m) => m.t === 'runs.changed' || m.t === 'run.changed');
  const pipelineRuns = useFeed(id, fetchPipelineRuns, (m) => m.t === 'pipelineRuns.changed');
  const repos = useFeed(id, fetchRepos, (m) => m.t === 'repos.changed');
  const metrics = useFeed(
    id,
    fetchMetrics,
    (m) => m.t === 'issues.changed' || m.t === 'prs.changed' || m.t === 'repos.changed',
  );
  const reports = useFeed(id, fetchReports, (m) => m.t === 'reports.changed');
  const pendingReviews = useFeed(id, fetchPendingReviews, (m) => m.t === 'prs.changed');
  const pendingTriage = useFeed(id, fetchPendingTriage, (m) => m.t === 'triage.changed' || m.t === 'issues.changed');

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
  const scopedRuns = runs.data && wsRepoNames ? runs.data.filter((r) => inWorkspace(r.repo)) : null;
  const openPrs = prs.data?.filter((p) => p.state === 'open') ?? null;
  const failingPrs = openPrs?.filter((p) => p.checks?.state === 'failing') ?? null;
  const liveRuns = scopedRuns?.filter((r) => r.live) ?? null;
  const reviewRuns = scopedRuns?.filter((r) => r.status === 'review') ?? null;
  // Without plan there are no proposals to wait for, so an empty list rather
  // than `null`: a permanently-loading tile would be its own bug.
  const actionableProposals = planEnabled
    ? (proposals.data?.filter((p) => p.status === 'analyzed' || p.status === 'review') ?? null)
    : [];
  const attentionCount =
    reviewRuns && pendingReviews.data && pendingTriage.data && failingPrs && actionableProposals
      ? reviewRuns.length +
        pendingReviews.data.length +
        pendingTriage.data.length +
        failingPrs.length +
        actionableProposals.length
      : null;

  const issueBacklog =
    metrics.data && issues.data
      ? backlogTrend(metrics.data.weekly, issues.data.length, (w) => w.issuesOpened, (w) => w.issuesClosed)
      : null;
  const prBacklog =
    metrics.data && openPrs
      ? backlogTrend(metrics.data.weekly, openPrs.length, (w) => w.prsOpened, (w) => w.prsClosed)
      : null;
  const issueBacklogDelta =
    metrics.data && issues.data
      ? {
          current: issues.data.length,
          previous: Math.max(0, issues.data.length - (metrics.data.issuesOpened7d - metrics.data.issuesClosed7d)),
          period: 'vs 7 days ago',
          upIsGood: false,
        }
      : undefined;
  const prBacklogDelta =
    metrics.data && openPrs
      ? {
          current: openPrs.length,
          previous: Math.max(0, openPrs.length - (metrics.data.prsOpened7d - metrics.data.prsClosed7d)),
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
    openIssueCount: issues.data?.length ?? null,
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
