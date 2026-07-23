import { useEffect, useState } from 'react';
import { codeApi as api } from '../api.js';

/**
 * Refresh GitHub when a workspace feed becomes visible. The cached page renders
 * immediately; sync broadcasts replace it with authoritative data as repos land.
 */
export interface WorkspaceRefreshState {
  readonly unavailableRepos: readonly string[];
  readonly error: string | null;
}

export function useWorkspaceRefresh(workspaceId: string | undefined): WorkspaceRefreshState {
  const [error, setError] = useState<string | null>(null);
  const [unavailableRepos, setUnavailableRepos] = useState<readonly string[]>([]);

  useEffect(() => {
    setError(null);
    setUnavailableRepos([]);
    if (!workspaceId) return;

    let active = true;
    void api
      .refreshWorkspace(workspaceId)
      .then((result) => {
        if (active) setUnavailableRepos(result.unavailableRepos);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return { unavailableRepos, error };
}
