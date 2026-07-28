import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { SlopRuleRecord } from '../../contract/index.js';
import { slopApi } from '../api.js';

/** The active workspace's rule set (built-ins + custom), kept live over slop.changed. */
export function useSlopRules(): {
  current: WorkspaceRecord | null;
  /** null until the first load resolves. */
  rules: SlopRuleRecord[] | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [rules, setRules] = useState<SlopRuleRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      setRules((await slopApi.rules(current.id)).rules);
      setError(null);
    } catch (err) {
      setError(String(err));
      setRules([]);
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'slop.changed');

  return { current, rules, error, setError, refresh };
}
