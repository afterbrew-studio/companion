import { useCallback, useState } from 'react';
import type { ReportRecord, RepoRecord, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useLive } from '../lib/live.js';
import { useWorkspaceRepos } from './useWorkspaceRepos.js';

/**
 * The Automations page's data: the active workspace, its repos (for the
 * per-repo switches), and the report feed they produce, kept live.
 */
export function useAutomations(): {
  current: WorkspaceRecord | null;
  repos: RepoRecord[];
  reports: ReportRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const { reports } = await api.listReports();
      setReports(reports);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'reports.changed' || msg.t === 'workspaces.changed');

  return { current, repos, reports, error, setError, refresh };
}
