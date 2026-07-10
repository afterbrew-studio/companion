import { useCallback, useEffect, useState } from 'react';
import type { ModelCatalogProvider } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The model-providers admin data: the merged provider list (config + whatever
 * the gateway reports), the disabled-model set, and the model catalog. The
 * error setter is exposed for the page's enable/import actions.
 */
export function useProviders(): {
  providers: Array<{ name: string; enabled: boolean }> | null;
  disabledModels: string[];
  catalog: ModelCatalogProvider[];
  catalogFresh: boolean | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  isModelDisabled: (provider: string, id: string) => boolean;
  toggleProvider: (name: string) => void;
  toggleModel: (provider: string, id: string) => void;
  removeManualId: (id: string) => void;
} {
  const [providers, setProviders] = useState<Array<{ name: string; enabled: boolean }> | null>(null);
  const [disabledModels, setDisabledModels] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogProvider[]>([]);
  const [catalogFresh, setCatalogFresh] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [settings, cat] = await Promise.all([api.getProviderSettings(), api.getModelsCatalog().catch(() => null)]);
      // Providers known to config plus providers the gateway reports.
      const names = new Set(settings.providers.map((p) => p.name));
      const merged = [...settings.providers];
      for (const p of cat?.providers ?? []) {
        if (!names.has(p.name)) merged.push({ name: p.name, enabled: p.enabled });
      }
      setProviders(merged.sort((a, b) => a.name.localeCompare(b.name)));
      setDisabledModels(settings.disabledModels);
      setCatalog(cat?.providers ?? []);
      setCatalogFresh(cat?.fresh ?? null);
      setError(null);
    } catch (err) {
      setError(String(err));
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Optimistic settings mutations: update local state, persist, then re-sync.
  const save = async (
    nextProviders: Array<{ name: string; enabled: boolean }>,
    nextModels: string[],
  ): Promise<void> => {
    setError(null);
    try {
      await api.setProviderSettings(
        nextProviders.filter((p) => !p.enabled).map((p) => p.name),
        nextModels,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };
  const isModelDisabled = (provider: string, id: string): boolean =>
    disabledModels.includes(id) || disabledModels.includes(`${provider}/${id}`);
  const toggleProvider = (name: string): void => {
    if (!providers) return;
    const next = providers.map((p) => (p.name === name ? { ...p, enabled: !p.enabled } : p));
    setProviders(next);
    void save(next, disabledModels);
  };
  const toggleModel = (provider: string, id: string): void => {
    if (!providers) return;
    const next = isModelDisabled(provider, id)
      ? disabledModels.filter((m) => m !== id && m !== `${provider}/${id}`)
      : [...disabledModels, id];
    setDisabledModels(next);
    void save(providers, next);
  };
  const removeManualId = (id: string): void => {
    if (!providers) return;
    const next = disabledModels.filter((m) => m !== id);
    setDisabledModels(next);
    void save(providers, next);
  };

  return {
    providers,
    disabledModels,
    catalog,
    catalogFresh,
    error,
    setError,
    refresh,
    isModelDisabled,
    toggleProvider,
    toggleModel,
    removeManualId,
  };
}
