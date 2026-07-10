import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { RepoRecord } from '@companion/module-code/contract';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RunRecord } from '@companion/module-operate/contract';
import { operateApi } from '@companion/module-operate/client';
import type { ReportRecord, WorkspaceRecord } from '@companion/module-workspace/contract';
import { useWorkspace, workspaceApi } from '@companion/module-workspace/client';

/**
 * The Daily Digest page's data: the workspace repos (the digest is per-repo),
 * the report + run feeds, and the currently-selected repo — which defaults to
 * the first repo and follows the live repo list. Kept live. Each feed is read
 * through its owning module's api slice — automations sits at the top of the
 * module graph, so code/operate/workspace are all legal imports.
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
        workspaceApi.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
        operateApi.listRuns().catch(() => ({ runs: [] as RunRecord[] })),
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
