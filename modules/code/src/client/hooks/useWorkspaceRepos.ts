import { useCallback, useRef, useState } from 'react';
import { readCached, useLive, writeCached } from '@moxxy/companion-sdk/client';
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
  const cacheKey = workspaceId ? `workspace-repos:${workspaceId}` : null;
  const retained = cacheKey === null ? null : readCached<RepoRecord[]>(cacheKey);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const [state, setState] = useState<{
    workspaceId: string | undefined;
    repos: RepoRecord[];
    loaded: boolean;
  }>({ workspaceId, repos: retained ?? [], loaded: retained !== null });
  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({ workspaceId, repos: [], loaded: true });
      return;
    }
    try {
      const { repos } = await api.workspaceRepos(workspaceId);
      if (workspaceRef.current === workspaceId) {
        if (cacheKey !== null) writeCached(cacheKey, repos);
        setState({ workspaceId, repos, loaded: true });
      }
    } catch {
      // A failed read is not an empty workspace; keep whatever is on screen and
      // let the gate stay quiet rather than accuse the instance of being unset up.
      if (workspaceRef.current === workspaceId) {
        setState((prev) => ({
          workspaceId,
          repos: prev.workspaceId === workspaceId ? prev.repos : [],
          loaded: true,
        }));
      }
    }
  }, [workspaceId, cacheKey]);
  useLive(load, (msg) => msg.t === 'repos.changed');
  return state.workspaceId === workspaceId
    ? state
    : { repos: retained ?? [], loaded: retained !== null };
}
