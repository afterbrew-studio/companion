import { useCallback, useEffect, useState } from 'react';
import { operateApi } from '@companion/module-operate/client';
import type { MoxxyStatus } from '@companion/module-operate/contract';
import { workspaceApi } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import { useLive } from '@moxxy-ai/companion-sdk/client';
import type { GitHubAccountRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

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
      const [{ accounts }, st] = await Promise.all([api.listGithubAccounts(), operateApi.status().catch(() => null)]);
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
    workspaceApi
      .listWorkspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => setWorkspaces([]));
  }, [refresh]);

  // Account mutations and the post-setup local-gh import reuse the existing
  // repos.changed signal, keeping this page correct even when import finishes
  // just after first-boot navigation.
  useLive(refresh, (message) => message.t === 'repos.changed');

  return { accounts, workspaces, status, error, setError, refresh };
}
