import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import type { DeskLaunchPlanRecord } from '../../contract/index.js';
import { deskApi } from '../api.js';

export interface LaunchPlansFeed {
  readonly plans: readonly DeskLaunchPlanRecord[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

/** One owner for the Terminal launch-review feed. The server pushes only to
 * the user whose delegated assistant prepared the plan. */
export function useLaunchPlans(workspaceId: string | null): LaunchPlansFeed {
  const [plans, setPlans] = useState<DeskLaunchPlanRecord[]>([]);
  const [loading, setLoading] = useState(workspaceId !== null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId) {
      setPlans([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await deskApi.launchPlans(workspaceId);
      setPlans(result.plans);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onServerMessage((message) => {
    if (message.t === 'desk.launch-plans.changed') void refresh();
  }), [refresh]);

  return { plans, loading, error, refresh };
}
