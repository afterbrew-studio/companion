import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-core/client';
import type { TaskModelSnapshot } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The instance's task → model pins plus the models any enabled machine can
 * serve. Each write is one task, and the server's answer (which recomputes the
 * offerable set) replaces local state, so a pin never renders against a model
 * list it was not validated against. Re-reads on `runners.changed`, which is how
 * a background catalog refresh reaches the page without anyone clicking.
 */
export function useTaskModels(): {
  snapshot: TaskModelSnapshot | null;
  error: string | null;
  saving: string | null;
  setPin: (taskId: string, model: string | null) => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<TaskModelSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.taskModels());
      setError(null);
    } catch (err) {
      setError(String(err));
      setSnapshot((prev) => prev ?? EMPTY);
    }
  }, []);

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
        setSnapshot(await api.setTaskModel(taskId, model));
      } catch (err) {
        setError(String(err));
        await refresh();
      } finally {
        setSaving(null);
      }
    },
  };
}

const EMPTY: TaskModelSnapshot = { tasks: [], models: [], defaultModel: '' };
