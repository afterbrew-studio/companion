import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { AreaStorageState, DocRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';

/**
 * The Documentation page's data, composed from smaller hooks: the active
 * workspace, its repos, the doc feed, and the storage config, kept live. The
 * page is presentation over this.
 */
export interface UseDocs {
  readonly current: WorkspaceRecord | null;
  readonly repos: RepoRecord[];
  /** null until the first load resolves. */
  readonly docs: DocRecord[] | null;
  readonly storage: AreaStorageState | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useDocs(): UseDocs {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [docs, setDocs] = useState<DocRecord[] | null>(null);
  const [storage, setStorage] = useState<AreaStorageState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [d, cfg] = await Promise.all([api.workspaceDocs(current.id), api.docsConfig(current.id)]);
      setDocs(d.docs);
      setStorage(cfg);
      setError(null);
    } catch (err) {
      setError(String(err));
      setDocs([]);
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'docs.changed');

  return { current, repos, docs, storage, error, refresh };
}
