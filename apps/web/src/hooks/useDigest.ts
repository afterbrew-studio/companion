import { useCallback, useEffect, useState } from 'react';
import type { ReportRecord, RepoRecord, RunRecord, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useLive } from '../lib/live.js';
import { useWorkspaceRepos } from './useWorkspaceRepos.js';

/**
 * The Daily Digest page's data: the workspace repos (the digest is per-repo),
 * the report + run feeds, and the currently-selected repo — which defaults to
 * the first repo and follows the live repo list. Kept live.
 */
export function useDigest(): {
  current: WorkspaceRecord | null;
  repos: RepoRecord[];
  reports: ReportRecord[];
  runs: RunRecord[];
  selected: string | null;
  setSelected: (repo: string | null) => void;
  loaded: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [rep, r] = await Promise.all([
        api.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
        api.listRuns().catch(() => ({ runs: [] as RunRecord[] })),
      ]);
      setReports(rep.reports);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'reports.changed' || msg.t === 'runs.changed' || msg.t === 'run.changed');

  // Default to the first repo; keep the pick valid as the repo list changes.
  useEffect(() => {
    setSelected((prev) => (prev && repos.some((x) => x.fullName === prev) ? prev : (repos[0]?.fullName ?? null)));
  }, [repos]);

  return { current, repos, reports, runs, selected, setSelected, loaded, error, setError, refresh };
}
