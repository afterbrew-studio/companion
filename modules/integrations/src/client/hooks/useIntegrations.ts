import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type {
  IntegrationCatalog,
  IntegrationConnectionDraft,
  IntegrationTargetRef,
  IntegrationCapability,
  IntegrationScope,
} from '../../contract/index.js';
import { integrationsApi, type IntegrationConnectionPatch } from '../api.js';

export interface IntegrationsState {
  readonly catalog: IntegrationCatalog | null;
  readonly error: string | null;
  readonly busy: string | null;
  readonly refresh: () => Promise<void>;
  readonly create: (draft: IntegrationConnectionDraft, personal?: boolean) => Promise<void>;
  readonly update: (id: string, patch: IntegrationConnectionPatch, personal?: boolean) => Promise<void>;
  readonly remove: (id: string, personal?: boolean) => Promise<void>;
  readonly test: (id: string, personal?: boolean) => Promise<void>;
  readonly setRoute: (
    capability: IntegrationCapability,
    scope: IntegrationScope,
    targets: readonly IntegrationTargetRef[],
  ) => Promise<void>;
}

/** The single live consumer for `integrations.changed`. Mutations refetch the
 * catalog rather than patching secrets/health/routing into parallel client state. */
export function useIntegrations(): IntegrationsState {
  const [catalog, setCatalog] = useState<IntegrationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCatalog(await integrationsApi.catalog());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useLive(refresh, (message) => message.t === 'integrations.changed');

  const run = useCallback(
    async (key: string, operation: () => Promise<unknown>): Promise<void> => {
      setBusy(key);
      setError(null);
      try {
        await operation();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return {
    catalog,
    error,
    busy,
    refresh,
    create: (draft, personal = false) => run('create', () => integrationsApi.create(draft, personal)),
    update: (id, patch, personal = false) => run(id, () => integrationsApi.update(id, patch, personal)),
    remove: (id, personal = false) => run(id, () => integrationsApi.remove(id, personal)),
    test: (id, personal = false) => run(id, () => integrationsApi.test(id, personal)),
    setRoute: (capability, scope, targets) =>
      run(`route:${capability}`, () => integrationsApi.setRoute(capability, scope, targets)),
  };
}
