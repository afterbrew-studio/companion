import { useCallback, useEffect, useState } from 'react';
import type {
  IssueRecord,
  PipelineRunRecord,
  PrRecord,
  ProposalRecord,
  ReportRecord,
  RepoRecord,
  RunRecord,
  WeeklyCounts,
  WorkspaceMetrics,
} from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';

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
  readonly actionableProposals: ProposalRecord[];
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
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
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
        api.workspaceProposals(current.id),
        api.listRuns(),
        api.workspacePipelineRuns(current.id),
        api.workspaceRepos(current.id),
        api.workspaceMetrics(current.id),
        api.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
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
        msg.t === 'proposals.changed' ||
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
