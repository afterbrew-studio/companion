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
  return useWorkspaceReposState(workspaceId).repos;
}

/**
 * The same list, with whether it has actually been read yet.
 *
 * "Empty" and "not answered yet" look identical in an array and mean opposite
 * things: a gate that reads the first as the second tells someone with twenty
 * repositories to go and add one, for as long as the request takes.
 */
export function useWorkspaceReposState(workspaceId: string | undefined): {
  repos: RepoRecord[];
  loaded: boolean;
} {
  const [state, setState] = useState<{ repos: RepoRecord[]; loaded: boolean }>({ repos: [], loaded: false });
  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({ repos: [], loaded: true });
      return;
    }
    try {
      const { repos } = await api.workspaceRepos(workspaceId);
      setState({ repos, loaded: true });
    } catch {
      // A failed read is not an empty workspace; keep whatever is on screen and
      // let the gate stay quiet rather than accuse the instance of being unset up.
      setState((prev) => ({ repos: prev.repos, loaded: true }));
    }
  }, [workspaceId]);
  useLive(load, (msg) => msg.t === 'repos.changed');
  return state;
}
