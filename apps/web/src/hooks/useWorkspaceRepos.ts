import { useCallback, useState } from 'react';
import type { RepoRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useLive } from '../lib/live.js';

/**
 * The active workspace's repositories, kept live (reloads on repos.changed).
 * One concern, one piece of state — reused by every page that needs the repo
 * list (filters, pickers, counts).
 */
export function useWorkspaceRepos(workspaceId: string | undefined): RepoRecord[] {
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const load = useCallback(async () => {
    if (!workspaceId) {
      setRepos([]);
      return;
    }
    try {
      const { repos } = await api.workspaceRepos(workspaceId);
      setRepos(repos);
    } catch {
      setRepos([]);
    }
  }, [workspaceId]);
  useLive(load, (msg) => msg.t === 'repos.changed');
  return repos;
}
