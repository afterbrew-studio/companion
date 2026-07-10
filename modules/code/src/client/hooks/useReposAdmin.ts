import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import { operateApi } from '@companion/module-operate/client';
import type { RunnerRecord } from '@companion/module-operate/contract';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { GitHubAccountRecord, RepoRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * The Repositories admin page's data: the workspace's repos (kept live, with a
 * manual refresh for after add/remove) plus the GitHub accounts and runners the
 * connect flow needs.
 */
export function useReposAdmin(): {
  current: WorkspaceRecord | null;
  repos: RepoRecord[];
  /** False until the first fetch lands — the page shows skeletons, not "no repos". */
  loaded: boolean;
  accounts: GitHubAccountRecord[];
  runners: RunnerRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState<GitHubAccountRecord[]>([]);
  const [runners, setRunners] = useState<RunnerRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const { repos } = await api.workspaceRepos(current.id);
      setRepos(repos);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, [current]);
  useLive(refresh, (msg) => msg.t === 'repos.changed' || msg.t === 'workspaces.changed');

  useEffect(() => {
    api
      .listGithubAccounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
    operateApi
      .listRunners()
      .then((r) => setRunners(r.runners))
      .catch(() => setRunners([]));
  }, []);

  return { current, repos, loaded, accounts, runners, error, setError, refresh };
}
