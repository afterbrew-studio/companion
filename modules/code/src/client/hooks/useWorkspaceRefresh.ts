import { useEffect, useState } from 'react';
import type { RepoRecord, RepoSyncFailure } from '../../contract/index.js';
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

export function useWorkspaceRefresh(
  workspaceId: string | undefined,
  repos: readonly RepoRecord[],
): WorkspaceRefreshState {
  const [error, setError] = useState<string | null>(null);
  const [unavailableRepos, setUnavailableRepos] = useState<readonly string[]>([]);
  const [failedRepos, setFailedRepos] = useState<readonly RepoSyncFailure[]>([]);
  // Membership, not list identity: a repository added while this feed is open
  // has never been refreshed, and a verdict from before it existed outlives it
  // otherwise. Every successful sync broadcasts repos.changed and reloads the
  // list, so refreshing on that instead would drive a loop.
  const members = repos
    .map((repo) => repo.fullName)
    .sort()
    .join(',');

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
  }, [workspaceId, members]);

  return { unavailableRepos, failedRepos, error };
}
