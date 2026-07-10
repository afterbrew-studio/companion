import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import { workspaceApi } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RunnerRecord } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

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
    workspaceApi
      .listWorkspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => setWorkspaces([]));
  }, []);

  return { runners, workspaces, error, setError, refresh };
}
