import { useCallback, useEffect, useState } from 'react';
import type { RunnerRecord, WorkspaceRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { useLive } from '../lib/live.js';

/**
 * The attached runner machines (kept live) plus the workspace list they can be
 * scoped to. `runners` is null until the first load resolves.
 */
export function useRunners(): {
  runners: RunnerRecord[] | null;
  workspaces: WorkspaceRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [runners, setRunners] = useState<RunnerRecord[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { runners } = await api.listRunners();
      setRunners(runners);
      setError(null);
    } catch (err) {
      setError(String(err));
      setRunners((prev) => prev ?? []);
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'runners.changed');

  useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => setWorkspaces([]));
  }, []);

  return { runners, workspaces, error, setError, refresh };
}
