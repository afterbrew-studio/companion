import { useCallback, useState } from 'react';
import { ApiError, useLive } from '@moxxy-ai/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { FeaturePlanningSession, PlannerSessionDetail } from '../../contract/index.js';
import { ideasApi } from '../api.js';

export function useIdeas(id?: string): {
  sessions: FeaturePlanningSession[] | null;
  detail: PlannerSessionDetail | null;
  legacyActiveCount: number;
  loading: boolean;
  missing: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [sessions, setSessions] = useState<FeaturePlanningSession[] | null>(null);
  const [detail, setDetail] = useState<PlannerSessionDetail | null>(null);
  const [legacyActiveCount, setLegacyActiveCount] = useState(0);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      if (id) {
        setDetail(await ideasApi.get(id));
        setMissing(false);
      } else {
        const result = await ideasApi.list(current.id);
        setSessions(result.sessions);
        setLegacyActiveCount(result.legacyActiveCount);
      }
      setError(null);
    } catch (err) {
      if (id && err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(String(err));
    }
  }, [current, id]);

  useLive(refresh, (message) => message.t === 'planner.changed');
  return {
    sessions,
    detail,
    legacyActiveCount,
    loading: id ? detail === null && !missing : sessions === null,
    missing,
    error,
    setError,
    refresh,
  };
}
