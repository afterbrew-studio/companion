import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { RepoRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * The active workspace's repositories, kept live (reloads on repos.changed).
 * One concern, one piece of state — reused by every page that needs the repo
 * list (filters, pickers, counts).
 *
 * This is the CANONICAL hook — operate carries a structural duplicate (repo
 * names only) because it sits below code in the dependency order.
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
