import { useCallback, useState } from 'react';
import type { AreaStorageState, RepoRecord, SpecRecord, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useLive } from '../lib/live.js';
import { useWorkspaceRepos } from './useWorkspaceRepos.js';

/**
 * The Specifications page's data, composed from smaller hooks: the active
 * workspace, its repos, the spec feed, and the storage config, kept live. The
 * page is presentation over this.
 */
export interface UseSpecs {
  readonly current: WorkspaceRecord | null;
  readonly repos: RepoRecord[];
  /** null until the first load resolves. */
  readonly specs: SpecRecord[] | null;
  readonly storage: AreaStorageState | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useSpecs(): UseSpecs {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [specs, setSpecs] = useState<SpecRecord[] | null>(null);
  const [storage, setStorage] = useState<AreaStorageState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [s, cfg] = await Promise.all([api.workspaceSpecs(current.id), api.specsConfig(current.id)]);
      setSpecs(s.specs);
      setStorage(cfg);
      setError(null);
    } catch (err) {
      setError(String(err));
      setSpecs([]);
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'specs.changed');

  return { current, repos, specs, storage, error, refresh };
}
