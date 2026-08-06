import { useCallback, useEffect, useState } from 'react';
import type { OperateStatus } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/** Platform execution + GitHub readiness, without coupling the UI to a runtime. */
export function useOperateStatus(): {
  status: OperateStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<OperateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, error, refresh };
}
