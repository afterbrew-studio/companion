import { useEffect, useState } from 'react';
import { onServerMessage } from '@companion/core/client';
import type { RunRecord } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The agent-run feed, kept live: a full reload on runs.changed and an in-place
 * patch (or prepend) on each run.changed. One concern; the error setter is
 * exposed for page-level actions (e.g. starting a run).
 */
export function useRuns(): {
  runs: RunRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { runs } = await api.listRuns();
      setRuns(runs);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'runs.changed') void refresh();
      if (msg.t === 'run.changed') {
        setRuns((prev) => {
          const i = prev.findIndex((r) => r.id === msg.run.id);
          if (i === -1) return [msg.run, ...prev];
          const next = [...prev];
          next[i] = msg.run;
          return next;
        });
      }
    });
  }, []);

  return { runs, error, setError, refresh };
}
