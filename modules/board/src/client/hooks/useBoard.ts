import { useCallback, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { BoardConfig, TaskRecord, WorkerView } from '../../contract/index.js';
import { boardApi } from '../api.js';

/** The whole board, kept live over board.changed (every engine transition broadcasts it). */
export function useBoard(): {
  tasks: TaskRecord[];
  workers: WorkerView[];
  config: BoardConfig | null;
  loaded: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [workers, setWorkers] = useState<WorkerView[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await boardApi.get();
      setTasks(snapshot.tasks);
      setWorkers(snapshot.workers);
      setConfig(snapshot.config);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useLive(refresh, (msg) => msg.t === 'board.changed');

  return { tasks, workers, config, loaded, error, setError, refresh };
}
