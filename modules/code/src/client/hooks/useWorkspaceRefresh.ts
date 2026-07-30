import { useEffect, useState } from 'react';
import type { RepoSyncFailure } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * Refresh GitHub when a workspace feed becomes visible. The cached page renders
 * immediately; sync broadcasts replace it with authoritative data as repos land.
 */
export interface WorkspaceRefreshState {
  readonly unavailableRepos: readonly string[];
  readonly failedRepos: readonly RepoSyncFailure[];
  readonly error: string | null;
}

export function useWorkspaceRefresh(workspaceId: string | undefined): WorkspaceRefreshState {
  const [error, setError] = useState<string | null>(null);
  const [unavailableRepos, setUnavailableRepos] = useState<readonly string[]>([]);
  const [failedRepos, setFailedRepos] = useState<readonly RepoSyncFailure[]>([]);

  useEffect(() => {
    setError(null);
    setUnavailableRepos([]);
    setFailedRepos([]);
    if (!workspaceId) return;

    let active = true;
    void api
      .refreshWorkspace(workspaceId)
      .then((result) => {
        if (!active) return;
        setUnavailableRepos(result.unavailableRepos);
        setFailedRepos(result.failedRepos);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return { unavailableRepos, failedRepos, error };
}
