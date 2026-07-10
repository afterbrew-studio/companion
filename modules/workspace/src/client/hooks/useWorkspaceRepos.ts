import { useCallback, useState } from 'react';
import { request, useLive } from '@companion/core/client';

/**
 * The active workspace's repositories, kept live (reloads on repos.changed).
 *
 * CYCLE NOTE: repos are module-code's domain and code depends on workspace, so
 * this module can import neither its `RepoRecord` nor its api slice. This is a
 * local duplicate of the legacy `useWorkspaceRepos` hook against code's
 * `/api/workspaces/:id/repos` route, typed structurally to just the fields the
 * Digest page reads. Keep in sync with module-code's repo DTO and route.
 */

/** Structural slice of module-code's `RepoRecord` (see cycle note above). */
export interface WorkspaceRepoLite {
  readonly fullName: string;
  readonly digestEnabled: boolean;
}

export function useWorkspaceRepos(workspaceId: string | undefined): WorkspaceRepoLite[] {
  const [repos, setRepos] = useState<WorkspaceRepoLite[]>([]);
  const load = useCallback(async () => {
    if (!workspaceId) {
      setRepos([]);
      return;
    }
    try {
      const { repos } = await request<{ repos: WorkspaceRepoLite[] }>(`/api/workspaces/${workspaceId}/repos`);
      setRepos(repos);
    } catch {
      setRepos([]);
    }
  }, [workspaceId]);
  // `repos.changed` is module-code's message — its registration is invisible
  // to this compilation, so match it as a plain string.
  useLive(load, (msg) => (msg.t as string) === 'repos.changed');
  return repos;
}
