import { useCallback, useEffect, useState } from 'react';
import type { MoxxyStatus } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The moxxy install status (CLI version, home, provider/GitHub readiness). One
 * concern; the error setter is exposed for pages whose actions share it.
 */
export function useMoxxyStatus(): {
  status: MoxxyStatus | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
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

  return { status, error, setError, refresh };
}
