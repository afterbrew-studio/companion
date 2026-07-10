import { useCallback, useState } from 'react';
import { request, useLive } from '@companion/core/client';

/**
 * The active workspace's repositories, kept live (reloads on repos.changed).
 *
 * Intentionally NOT shared with `modules/code/src/client/hooks/useWorkspaceRepos.ts`.
 * The canonical hook (and the `/api/workspaces/:id/repos` route + the
 * `repos.changed` message) belongs to module-code, which depends on operate, so
 * operate cannot import it without a client-side cycle, and hoisting it into the
 * framework would leak code's API surface into core. RunsPage only scopes runs by
 * repo name, so the repo shape is structural (`fullName` only) rather than
 * module-code's `RepoRecord`, and the `repos.changed` comparison is widened —
 * that literal is not in operate's visible message union.
 */
export interface WorkspaceRepoRef {
  readonly fullName: string;
}

export function useWorkspaceRepos(workspaceId: string | undefined): WorkspaceRepoRef[] {
  const [repos, setRepos] = useState<WorkspaceRepoRef[]>([]);
  const load = useCallback(async () => {
    if (!workspaceId) {
      setRepos([]);
      return;
    }
    try {
      const { repos } = await request<{ repos: WorkspaceRepoRef[] }>(`/api/workspaces/${workspaceId}/repos`);
      setRepos(repos);
    } catch {
      setRepos([]);
    }
  }, [workspaceId]);
  useLive(load, (msg) => (msg.t as string) === 'repos.changed');
  return repos;
}
