import { useCallback, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { RepoRecord } from '@companion/module-code/contract';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { ReportRecord, WorkspaceRecord } from '@companion/module-workspace/contract';
import { useWorkspace, workspaceApi } from '@companion/module-workspace/client';

/**
 * The Automations page's data: the active workspace, its repos (for the
 * per-repo switches), and the report feed they produce, kept live. The reports
 * read is module-workspace's — its api slice owns `/api/reports`.
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
      const { reports } = await workspaceApi.listReports();
      setReports(reports);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'reports.changed' || msg.t === 'workspaces.changed');

  return { current, repos, reports, error, setError, refresh };
}
