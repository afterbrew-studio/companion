import { useCallback, useEffect, useState } from 'react';
import { onServerMessage, request } from '@companion/core/client';
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
 * every derived "needs a human" queue and backlog trend. The page is pure
 * presentation over this.
 */
export interface UseOverview {
  readonly hasWorkspace: boolean;
  readonly workspaceName: string;
  readonly error: string | null;

  readonly repos: RepoRecord[];
  readonly metrics: WorkspaceMetrics | null;
  /** Runs and reports already scoped to this workspace's repos (or instance-wide). */
  readonly workspaceRuns: RunRecord[];
  readonly workspaceReports: ReportRecord[];
  readonly pipelineRuns: PipelineRunRecord[];

  readonly openIssueCount: number;
  readonly openPrs: PrRecord[];
  readonly failingPrs: PrRecord[];
  readonly liveRuns: RunRecord[];
  readonly reviewRuns: RunRecord[];
  readonly actionableProposals: OverviewProposal[];
  readonly prReviewsPending: PrRecord[];
  readonly triagePending: IssueRecord[];
  readonly attentionCount: number;

  readonly issueBacklog: number[] | null;
  readonly prBacklog: number[] | null;
  readonly issueBacklogDelta: Delta | undefined;
  readonly prBacklogDelta: Delta | undefined;
}

export function useOverview(): UseOverview {
  const { current } = useWorkspace();
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [prs, setPrs] = useState<PrRecord[]>([]);
  const [proposals, setProposals] = useState<OverviewProposal[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRecord[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [metrics, setMetrics] = useState<WorkspaceMetrics | null>(null);
  const [prReviewsPending, setPrReviewsPending] = useState<PrRecord[]>([]);
  const [triagePending, setTriagePending] = useState<IssueRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [i, p, pr, r, plr, rp, m, rep, pendRev, pendTri] = await Promise.all([
        api.workspaceIssues(current.id, 'open'),
        api.workspacePrs(current.id),
        workspaceProposals(current.id),
        operateApi.listRuns(),
        api.workspacePipelineRuns(current.id),
        api.workspaceRepos(current.id),
        workspaceApi.workspaceMetrics(current.id),
        workspaceApi.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
        api.workspacePrs(current.id, 'open', { review: 'pending', limit: 50 }),
        api.workspaceIssues(current.id, 'open', { triage: 'pending', limit: 50 }),
      ]);
      setIssues(i.issues);
      setPrs(p.prs);
      setProposals(pr.proposals);
      setRuns(r.runs);
      setPipelineRuns(plr.runs);
      setRepos(rp.repos);
      setMetrics(m.metrics);
      setReports(rep.reports);
      setPrReviewsPending(pendRev.prs);
      setTriagePending(pendTri.issues);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (
        msg.t === 'issues.changed' ||
        msg.t === 'prs.changed' ||
        // FLAG: plan's message literal — not in code's visible union (plan depends on us).
        (msg.t as string) === 'proposals.changed' ||
        msg.t === 'runs.changed' ||
        msg.t === 'run.changed' ||
        msg.t === 'pipelineRuns.changed' ||
        msg.t === 'repos.changed' ||
        msg.t === 'reports.changed' ||
        msg.t === 'triage.changed'
      ) {
        void refresh();
      }
    });
  }, [refresh]);

  const wsRepoNames = new Set(repos.map((r) => r.fullName));
  const inWorkspace = (repo: string | null): boolean => repo === null || wsRepoNames.has(repo);
  const openPrs = prs.filter((p) => p.state === 'open');
  const failingPrs = openPrs.filter((p) => p.checks?.state === 'failing');
  const liveRuns = runs.filter((r) => r.live && inWorkspace(r.repo));
  const reviewRuns = runs.filter((r) => r.status === 'review' && inWorkspace(r.repo));
  const actionableProposals = proposals.filter((p) => p.status === 'analyzed' || p.status === 'review');
  const attentionCount =
    reviewRuns.length + prReviewsPending.length + triagePending.length + failingPrs.length + actionableProposals.length;

  const issueBacklog = metrics
    ? backlogTrend(metrics.weekly, issues.length, (w) => w.issuesOpened, (w) => w.issuesClosed)
    : null;
  const prBacklog = metrics
    ? backlogTrend(metrics.weekly, openPrs.length, (w) => w.prsOpened, (w) => w.prsClosed)
    : null;
  const issueBacklogDelta = metrics
    ? {
        current: issues.length,
        previous: Math.max(0, issues.length - (metrics.issuesOpened7d - metrics.issuesClosed7d)),
        period: 'vs 7 days ago',
        upIsGood: false,
      }
    : undefined;
  const prBacklogDelta = metrics
    ? {
        current: openPrs.length,
        previous: Math.max(0, openPrs.length - (metrics.prsOpened7d - metrics.prsClosed7d)),
        period: 'vs 7 days ago',
        upIsGood: false,
      }
    : undefined;

  return {
    hasWorkspace: !!current,
    workspaceName: current?.name ?? '',
    error,
    repos,
    metrics,
    workspaceRuns: runs.filter((r) => inWorkspace(r.repo)),
    workspaceReports: reports.filter((r) => inWorkspace(r.repo)),
    pipelineRuns,
    openIssueCount: issues.length,
    openPrs,
    failingPrs,
    liveRuns,
    reviewRuns,
    actionableProposals,
    prReviewsPending,
    triagePending,
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
