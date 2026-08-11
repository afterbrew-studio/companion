import { useCallback, useState } from 'react';
import { readCached, useLive, writeCached } from '@moxxy/companion-sdk/client';
import type {
  IntegrationCatalog,
  IntegrationConnectionDraft,
  IntegrationTargetRef,
  IntegrationCapability,
  IntegrationScope,
} from '../../contract/index.js';
import { integrationsApi, type IntegrationConnectionPatch } from '../api.js';

const CATALOG_KEY = 'integrations:catalog';

/**
 * Singleton in-flight fetch: a PR page mounts this hook more than once, and
 * every instance refreshes on the same integrations.changed — they must share
 * one request per event instead of refetching the catalog per mount. The
 * result is retained in the auth-cleared render cache so a new mount paints
 * instantly while it revalidates.
 */
let inflightCatalog: Promise<IntegrationCatalog> | null = null;

function fetchCatalog(): Promise<IntegrationCatalog> {
  inflightCatalog ??= integrationsApi
    .catalog()
    .then((catalog) => {
      writeCached(CATALOG_KEY, catalog);
      return catalog;
    })
    .finally(() => {
      inflightCatalog = null;
    });
  return inflightCatalog;
}

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
  const [catalog, setCatalog] = useState<IntegrationCatalog | null>(() => readCached<IntegrationCatalog>(CATALOG_KEY));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCatalog(await fetchCatalog());
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
