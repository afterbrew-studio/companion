import { useCallback, useEffect, useState } from 'react';
import { request, useLive } from '@companion/core/client';
import type { ReportRecord, WorkspaceRecord } from '../../contract/index.js';
import { workspaceApi } from '../api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useWorkspaceRepos, type WorkspaceRepoLite } from './useWorkspaceRepos.js';

/**
 * CYCLE NOTE: agent runs are module-operate's domain and operate depends on
 * workspace, so this module can import neither its `RunRecord` nor its api
 * slice. The Digest page only needs to spot a live report run, so we call
 * operate's `/api/runs` route directly, typed structurally to those fields.
 * Keep in sync with module-operate's run DTO and route.
 */
export interface RunLite {
  readonly id: string;
  readonly kind: string;
  readonly repo: string | null;
  readonly live: boolean;
}

/**
 * The Daily Digest page's data: the workspace repos (the digest is per-repo),
 * the report + run feeds, and the currently-selected repo — which defaults to
 * the first repo and follows the live repo list. Kept live.
 */
export function useDigest(): {
  current: WorkspaceRecord | null;
  repos: WorkspaceRepoLite[];
  reports: ReportRecord[];
  runs: RunLite[];
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
  const [runs, setRuns] = useState<RunLite[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [rep, r] = await Promise.all([
        workspaceApi.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
        request<{ runs: RunLite[] }>('/api/runs').catch(() => ({ runs: [] as RunLite[] })),
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

  // `runs.changed`/`run.changed` are module-operate's messages — invisible to
  // this compilation, so match them as plain strings.
  useLive(
    refresh,
    (msg) => msg.t === 'reports.changed' || (msg.t as string) === 'runs.changed' || (msg.t as string) === 'run.changed',
  );

  // Default to the first repo; keep the pick valid as the repo list changes.
  useEffect(() => {
    setSelected((prev) => (prev && repos.some((x) => x.fullName === prev) ? prev : (repos[0]?.fullName ?? null)));
  }, [repos]);

  return { current, repos, reports, runs, selected, setSelected, loaded, error, setError, refresh };
}
