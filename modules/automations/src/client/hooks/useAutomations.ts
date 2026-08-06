import { useCallback, useRef, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { RepoRecord } from '@companion/module-code/contract';
import { useWorkspaceReposState } from '@companion/module-code/client';
import type { ReportRecord, WorkspaceRecord } from '@companion/module-workspace/contract';
import { useWorkspace, workspaceApi } from '@companion/module-workspace/client';

/**
 * Shared automation-page data: the active workspace, its repository index and
 * the report feed they produce, kept live. The reports read is
 * module-workspace's — its api slice owns `/api/reports`.
 */
export function useAutomations(): {
  current: WorkspaceRecord | null;
  repos: RepoRecord[];
  reposLoaded: boolean;
  reports: ReportRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const { repos, loaded: reposLoaded } = useWorkspaceReposState(current?.id);
  const workspaceRef = useRef(current?.id);
  workspaceRef.current = current?.id;
  const [reportState, setReportState] = useState<{
    workspaceId: string | undefined;
    reports: ReportRecord[];
  }>({ workspaceId: current?.id, reports: [] });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const workspaceId = current?.id;
    if (!workspaceId) {
      setReportState({ workspaceId, reports: [] });
      return;
    }
    try {
      const { reports } = await workspaceApi.listReports();
      if (workspaceRef.current === workspaceId) {
        setReportState({ workspaceId, reports });
        setError(null);
      }
    } catch (err) {
      if (workspaceRef.current === workspaceId) setError(String(err));
    }
  }, [current?.id]);

  useLive(refresh, (msg) => msg.t === 'reports.changed' || msg.t === 'workspaces.changed');

  const reports = reportState.workspaceId === current?.id ? reportState.reports : [];
  return { current, repos, reposLoaded, reports, error, setError, refresh };
}
