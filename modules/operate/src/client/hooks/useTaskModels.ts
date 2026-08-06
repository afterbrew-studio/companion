import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-core/client';
import type { RunLane, TaskModelSnapshot } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The instance's task → model pins plus the models any enabled machine can
 * serve. Each write is one task, and the server's answer (which recomputes the
 * offerable set) replaces local state, so a pin never renders against a model
 * list it was not validated against. Re-reads on `runners.changed`, which is how
 * a background catalog refresh reaches the page without anyone clicking.
 */
export function useTaskModels(lane?: RunLane): {
  snapshot: TaskModelSnapshot | null;
  error: string | null;
  saving: string | null;
  setPin: (taskId: string, model: string | null) => Promise<void>;
  setLaneDefault: (model: string | null) => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<TaskModelSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // Compared by value: the caller rebuilds the object each render, and keying
  // the effect on its identity would refetch on every keystroke elsewhere.
  const laneKey = lane ? `${lane.runnerId}:${lane.harness}` : '';

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.taskModels(lane));
      setError(null);
    } catch (err) {
      setError(String(err));
      setSnapshot((prev) => prev ?? EMPTY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneKey]);

  // Pins move here; the offerable model set moves with the machines' catalogs.
  useLive(refresh, (msg) => msg.t === 'task-models.changed' || msg.t === 'runners.changed');

  return {
    snapshot,
    error,
    saving,
    setPin: async (taskId, model) => {
      setSaving(taskId);
      setError(null);
      try {
        setSnapshot(await api.setTaskModel(taskId, model, lane));
      } catch (err) {
        setError(String(err));
        await refresh();
      } finally {
        setSaving(null);
      }
    },
    setLaneDefault: async (model) => {
      if (!lane) return;
      setSaving('__lane_default__');
      setError(null);
      try {
        setSnapshot(await api.setLaneDefaultModel(lane, model));
      } catch (err) {
        setError(String(err));
        await refresh();
      } finally {
        setSaving(null);
      }
    },
  };
}

const EMPTY: TaskModelSnapshot = { tasks: [], models: [] };
