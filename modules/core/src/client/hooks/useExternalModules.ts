import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-core/client';
import type { ExternalModulesResponse } from '../../contract/index.js';
import { modulesApi } from '../api.js';

/**
 * The out-of-tree module files on the host. Kept apart from the kernel catalog
 * that `useKernel()` serves, because they answer different questions: the
 * catalog is what this daemon loaded at boot, this is what is on disk now, and
 * the gap between them is exactly what the Modules page has to show.
 *
 * Refetches on `modules.changed`, the same event every module mutation already
 * broadcasts, so a second admin adding a module updates this list too.
 */
export function useExternalModules(): {
  state: ExternalModulesResponse | null;
  error: string | null;
  reload: () => void;
} {
  const [state, setState] = useState<ExternalModulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    void modulesApi
      .listExternal()
      .then((r) => alive && (setState(r), setError(null)))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(
    () =>
      onServerMessage((msg) => {
        if (msg.t === 'modules.changed') reload();
      }),
    [reload],
  );

  return { state, error, reload };
}
