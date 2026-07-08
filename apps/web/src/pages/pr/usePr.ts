import { useCallback, useEffect, useState } from 'react';
import type {
  PipelineRecord,
  PipelineRunRecord,
  PrRecord,
  PrReviewResult,
  ReportRecord,
} from '@companion/contract';
import { api, onServerMessage } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useWorkspace } from '../../lib/workspace.js';

/**
 * All of the business knowledge for one pull request — the data feed, the live
 * refresh wiring, and every action a reviewer can take — in one place. The PR,
 * review and building views are just different presentations over this hook.
 */
export interface UsePr {
  readonly pr: PrRecord | null;
  readonly review: PrReviewResult | null;
  readonly pipelineRuns: PipelineRunRecord[];
  readonly ciAnalysis: ReportRecord | null;
  /** PR pipelines the current workspace can run against this PR. */
  readonly pipelines: PipelineRecord[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly setError: (e: string | null) => void;
  readonly refresh: () => Promise<void>;
  readonly canAct: boolean;

  /** AI review agent. */
  readonly analyzing: boolean;
  readonly analyze: () => Promise<void>;
  readonly applyReview: (accountId?: string) => Promise<void>;
  readonly dismissReview: () => Promise<void>;

  /** Repair agents — both open the building preview for the run they start. */
  readonly agentBusy: 'checks' | 'reviews' | null;
  readonly fixChecks: () => Promise<void>;
  readonly addressReviews: () => Promise<void>;

  /** Lifecycle actions. */
  readonly busy: boolean;
  readonly merge: (method?: 'merge' | 'squash' | 'rebase') => Promise<void>;
  readonly close: () => Promise<void>;
  readonly runPipeline: (pipelineId: string) => Promise<void>;
}

export function usePr(repo: string, number: number): UsePr {
  const { can } = useAuth();
  const { current } = useWorkspace();
  const canAct = can('prs:act');

  const [pr, setPr] = useState<PrRecord | null>(null);
  const [review, setReview] = useState<PrReviewResult | null>(null);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRecord[]>([]);
  const [ciAnalysis, setCiAnalysis] = useState<ReportRecord | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState<'checks' | 'reviews' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api.getPr(repo, number);
      setPr(r.pr);
      setReview(r.review);
      setPipelineRuns(r.pipelineRuns);
      setCiAnalysis(r.ciAnalysis);
      if (r.review && r.review.status !== 'failed') setAnalyzing(false);
    } catch (err) {
      setError(String(err));
    }
  }, [repo, number]);

  useEffect(() => {
    void refresh();
    if (current && can('pipelines:read')) {
      api
        .workspacePipelines(current.id)
        .then((r) => setPipelines(r.pipelines.filter((p) => p.type === 'pr')))
        .catch(() => undefined);
    }
    return onServerMessage((msg) => {
      if ((msg.t === 'prs.changed' || msg.t === 'pipelineRuns.changed') && msg.repo === repo) void refresh();
      if (msg.t === 'reports.changed') void refresh();
    });
  }, [refresh, current, can, repo]);

  const analyze = useCallback(async (): Promise<void> => {
    setAnalyzing(true);
    setError(null);
    try {
      await api.analyzePr(repo, number);
    } catch (err) {
      setAnalyzing(false);
      setError(String(err));
    }
  }, [repo, number]);

  const withBusy = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Repair agents push to the PR's own branch, so we follow the run into the
  // building preview rather than the raw transcript.
  const startAgent = useCallback(
    async (kind: 'checks' | 'reviews'): Promise<void> => {
      setAgentBusy(kind);
      setError(null);
      try {
        const { run } = await (kind === 'checks' ? api.fixChecks(repo, number) : api.addressReviews(repo, number));
        location.hash = `#/runs/${run.id}/preview`;
      } catch (err) {
        setError(String(err));
        setAgentBusy(null);
      }
    },
    [repo, number],
  );

  return {
    pr,
    review,
    pipelineRuns,
    ciAnalysis,
    pipelines,
    loading: pr === null && error === null,
    error,
    setError,
    refresh,
    canAct,
    analyzing,
    analyze,
    applyReview: (accountId) => withBusy(() => api.applyPrReview(review!.id, accountId)),
    dismissReview: () => withBusy(() => api.dismissPrReview(review!.id)),
    agentBusy,
    fixChecks: () => startAgent('checks'),
    addressReviews: () => startAgent('reviews'),
    busy,
    merge: (method = 'squash') => withBusy(() => api.mergePr(repo, number, method)),
    close: () => withBusy(() => api.closePr(repo, number)),
    runPipeline: (pipelineId) => withBusy(() => api.runPipeline(repo, number, pipelineId)),
  };
}
