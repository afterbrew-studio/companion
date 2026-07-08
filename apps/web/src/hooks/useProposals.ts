import { useCallback, useState } from 'react';
import type { ProposalRecord, RepoRecord, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useLive } from '../lib/live.js';
import { useWorkspaceRepos } from './useWorkspaceRepos.js';

/**
 * The Proposals page's data, composed from smaller hooks: the active workspace,
 * its repos (for the create form), the proposal feed, and the live refresh. The
 * page is presentation over this.
 */
export interface UseProposals {
  readonly current: WorkspaceRecord | null;
  readonly repos: RepoRecord[];
  readonly proposals: ProposalRecord[];
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useProposals(): UseProposals {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const { proposals } = await api.workspaceProposals(current.id);
      setProposals(proposals);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'proposals.changed' || msg.t === 'run.changed');

  return { current, repos, proposals, error, refresh };
}
