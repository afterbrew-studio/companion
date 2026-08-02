import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { RepoRecord } from '@companion/module-code/contract';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RunListRecord } from '@companion/module-operate/contract';
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
  runs: RunListRecord[];
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
  const [runs, setRuns] = useState<RunListRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [rep, r] = await Promise.all([
        workspaceApi.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
        operateApi
          .listRunsPage({ workspace: current.id, status: 'active', limit: 100 })
          .catch(() => ({ runs: [] as RunListRecord[], total: 0 })),
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
    setSelected((prev) =>
      prev && repos.some((x) => x.fullName === prev && x.githubAccessible)
        ? prev
        : (repos.find((x) => x.githubAccessible)?.fullName ?? null),
    );
  }, [repos]);

  return { current, repos, reports, runs, selected, setSelected, loaded, error, setError, refresh };
}
