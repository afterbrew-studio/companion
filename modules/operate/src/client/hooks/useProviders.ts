import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@moxxy/companion-core/client';
import type { CatalogMachine, ProviderCatalog, RunnerProviderPolicy } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

/**
 * The per-machine provider/model groups plus the merged effective set. Machines
 * fetch their own models on the daemon side, so this hook only reads, and
 * re-reads on `runners.changed`, which is how a background refresh reaches the
 * page without anyone clicking. Every toggle writes one machine's policy and
 * the server's answer (which recomputes the merged set) replaces local state.
 */
export function useProviders(): {
  catalog: ProviderCatalog | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  refetchFromMachines: () => Promise<void>;
  refetching: boolean;
  toggleProvider: (machine: CatalogMachine, name: string) => void;
  toggleModel: (machine: CatalogMachine, provider: string, id: string) => void;
  enableStranded: (machine: CatalogMachine, id: string) => void;
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

  const save = async (machineId: string, policy: RunnerProviderPolicy): Promise<void> => {
    setError(null);
    try {
      setCatalog(await api.setRunnerProviderPolicy(machineId, policy));
    } catch (err) {
      setError(String(err));
      await refresh();
    }
  };

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
    toggleProvider: (machine, name) => {
      const off = machine.policy.disabledProviders.includes(name);
      void save(machine.id, {
        ...machine.policy,
        disabledProviders: off
          ? machine.policy.disabledProviders.filter((p) => p !== name)
          : [...machine.policy.disabledProviders, name],
      });
    },
    toggleModel: (machine, provider, id) => {
      const enabled = machine.providers
        .find((p) => p.name === provider)
        ?.models.find((m) => m.id === id)?.enabled;
      void save(machine.id, {
        ...machine.policy,
        // Enabling clears both id forms; disabling adds the bare one, leaving
        // any provider-scoped entry the user already had untouched.
        disabledModels: enabled
          ? [...machine.policy.disabledModels, id]
          : machine.policy.disabledModels.filter((m) => m !== id && m !== `${provider}/${id}`),
      });
    },
    enableStranded: (machine, id) => {
      void save(machine.id, {
        ...machine.policy,
        disabledModels: machine.policy.disabledModels.filter((m) => m !== id),
      });
    },
  };
}

const EMPTY: ProviderCatalog = {
  providers: [],
  machines: [],
  defaultModel: '',
  fetchedAt: null,
};
