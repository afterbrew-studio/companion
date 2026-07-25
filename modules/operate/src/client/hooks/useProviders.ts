import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { ProviderCatalog } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The merged provider/model catalog plus the instance policy that hides parts
 * of it. Machines fetch their own models on the daemon side, so this hook only
 * reads — and re-reads on `runners.changed`, which is how a background refresh
 * reaches the page without anyone clicking. Toggles apply optimistically and
 * the server's answer replaces local state.
 */
export function useProviders(): {
  catalog: ProviderCatalog | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  refetchFromMachines: () => Promise<void>;
  refetching: boolean;
  isModelDisabled: (provider: string, id: string) => boolean;
  toggleProvider: (name: string) => void;
  toggleModel: (provider: string, id: string) => void;
  removeManualId: (id: string) => void;
} {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCatalog(await api.providerCatalog());
      setError(null);
    } catch (err) {
      setError(String(err));
      setCatalog((prev) => prev ?? EMPTY);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useLive(refresh, (msg) => msg.t === 'runners.changed');

  const save = async (next: ProviderCatalog): Promise<void> => {
    setCatalog(next);
    setError(null);
    try {
      setCatalog(
        await api.setProviderPolicy(
          next.providers.filter((p) => !p.enabled).map((p) => p.name),
          [...next.disabledModels],
        ),
      );
    } catch (err) {
      setError(String(err));
      await refresh();
    }
  };

  const isModelDisabled = (provider: string, id: string): boolean =>
    (catalog?.disabledModels ?? []).some((m) => m === id || m === `${provider}/${id}`);

  return {
    catalog,
    error,
    setError,
    refresh,
    refetching,
    refetchFromMachines: async () => {
      setRefetching(true);
      setError(null);
      try {
        setCatalog(await api.refreshProviderCatalog());
      } catch (err) {
        setError(String(err));
      } finally {
        setRefetching(false);
      }
    },
    isModelDisabled,
    toggleProvider: (name) => {
      if (!catalog) return;
      void save({
        ...catalog,
        providers: catalog.providers.map((p) => (p.name === name ? { ...p, enabled: !p.enabled } : p)),
      });
    },
    toggleModel: (provider, id) => {
      if (!catalog) return;
      const disabledModels = isModelDisabled(provider, id)
        ? catalog.disabledModels.filter((m) => m !== id && m !== `${provider}/${id}`)
        : [...catalog.disabledModels, id];
      void save({ ...catalog, disabledModels });
    },
    removeManualId: (id) => {
      if (!catalog) return;
      void save({ ...catalog, disabledModels: catalog.disabledModels.filter((m) => m !== id) });
    },
  };
}

const EMPTY: ProviderCatalog = {
  providers: [],
  machines: [],
  disabledModels: [],
  defaultModel: '',
  fetchedAt: null,
};
