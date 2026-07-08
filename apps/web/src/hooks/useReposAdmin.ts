import { useCallback, useEffect, useState } from 'react';
import type { GitHubAccountRecord, RepoRecord, RunnerRecord, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useLive } from '../lib/live.js';

/**
 * The Repositories admin page's data: the workspace's repos (kept live, with a
 * manual refresh for after add/remove) plus the GitHub accounts and runners the
 * connect flow needs.
 */
export function useReposAdmin(): {
  current: WorkspaceRecord | null;
  repos: RepoRecord[];
  accounts: GitHubAccountRecord[];
  runners: RunnerRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [repos, setRepos] = useState<RepoRecord[]>([]);
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
    }
  }, [current]);
  useLive(refresh, (msg) => msg.t === 'repos.changed' || msg.t === 'workspaces.changed');

  useEffect(() => {
    api
      .listGithubAccounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts([]));
    api
      .listRunners()
      .then((r) => setRunners(r.runners))
      .catch(() => setRunners([]));
  }, []);

  return { current, repos, accounts, runners, error, setError, refresh };
}
