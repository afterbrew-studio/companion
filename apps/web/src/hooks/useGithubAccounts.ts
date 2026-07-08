import { useCallback, useEffect, useState } from 'react';
import type { GitHubAccountRecord, MoxxyStatus, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';

/**
 * The GitHub accounts admin data: the connected accounts (null until loaded)
 * and instance status, plus the workspace list for scoping. The error setter is
 * exposed for the page's connect/toggle/remove actions.
 */
export function useGithubAccounts(): {
  accounts: GitHubAccountRecord[] | null;
  workspaces: WorkspaceRecord[];
  status: MoxxyStatus | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [accounts, setAccounts] = useState<GitHubAccountRecord[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ accounts }, st] = await Promise.all([api.listGithubAccounts(), api.status().catch(() => null)]);
      setAccounts(accounts);
      setStatus(st);
      setError(null);
    } catch (err) {
      setError(String(err));
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .listWorkspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => setWorkspaces([]));
  }, [refresh]);

  return { accounts, workspaces, status, error, setError, refresh };
}
