import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { ModelRouterPolicyUpdate, ModelRouterSnapshot } from '../../contract/index.js';
import { modelRouterApi } from '../api.js';

export function useModelRouter(): {
  readonly snapshot: ModelRouterSnapshot | null;
  readonly error: string | null;
  readonly saving: boolean;
  readonly save: (update: ModelRouterPolicyUpdate) => Promise<boolean>;
} {
  const [snapshot, setSnapshot] = useState<ModelRouterSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await modelRouterApi.snapshot());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);
  useLive(refresh, (message) =>
    message.t === 'model-router.changed' || message.t === 'runners.changed' || message.t === 'run.changed',
  );
  return {
    snapshot,
    error,
    saving,
    save: async (update) => {
      setSaving(true);
      setError(null);
      try {
        await modelRouterApi.updatePolicy(update);
        await refresh();
        return true;
      } catch (err) {
        setError(String(err));
        await refresh();
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}
