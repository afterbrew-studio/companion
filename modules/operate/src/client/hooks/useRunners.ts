import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import { workspaceApi } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RunnerRecord, RunTaskDescriptor } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The attached runner machines (kept live) plus the workspace list they can be
 * scoped to and the registered task descriptors (for the per-runner task
 * filter). `runners` is null until the first load resolves.
 */
export function useRunners(): {
  runners: RunnerRecord[] | null;
  tasks: RunTaskDescriptor[];
  workspaces: WorkspaceRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [runners, setRunners] = useState<RunnerRecord[] | null>(null);
  const [tasks, setTasks] = useState<RunTaskDescriptor[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { runners, tasks } = await api.listRunners();
      setRunners(runners);
      // A daemon on a pre-task dist omits the field — don't crash the page.
      setTasks(tasks ?? []);
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

  return { runners, tasks, workspaces, error, setError, refresh };
}
