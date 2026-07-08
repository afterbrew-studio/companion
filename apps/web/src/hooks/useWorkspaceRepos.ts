import { useEffect, useState } from 'react';
import type { RepoRecord } from '@companion/contract';
import { api } from '../lib/api.js';

/**
 * The active workspace's repositories. One concern, one piece of state — reused
 * by every page that needs the repo list (filters, pickers, counts).
 */
export function useWorkspaceRepos(workspaceId: string | undefined): RepoRecord[] {
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  useEffect(() => {
    if (!workspaceId) {
      setRepos([]);
      return;
    }
    let alive = true;
    api
      .workspaceRepos(workspaceId)
      .then(({ repos }) => alive && setRepos(repos))
      .catch(() => alive && setRepos([]));
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  return repos;
}
