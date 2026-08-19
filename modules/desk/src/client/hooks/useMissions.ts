import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import type { DeskMissionView } from '../../contract/index.js';
import { deskApi } from '../api.js';

export interface UseMissions {
  readonly missions: readonly DeskMissionView[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

/** One live owner for the mission list. Coarse mission changes refetch; the
 * frequent run event patches its one matching row in place. */
export function useMissions(): UseMissions {
  const [missions, setMissions] = useState<DeskMissionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const { missions: next } = await deskApi.missions();
      setMissions(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onServerMessage((message) => {
      if (message.t === 'desk.missions.changed') void refresh();
      else if (message.t === 'run.changed') {
        setMissions((current) =>
          current.map((entry) =>
            entry.mission.runId === message.run.id ? { ...entry, run: message.run } : entry,
          ),
        );
      }
    });
  }, [refresh]);

  return { missions, loading, error, refresh };
}
