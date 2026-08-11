import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type {
  CreateProviderRequest,
  ModelProviderRecord,
  ProbeResult,
  UpdateProviderRequest,
} from '../../contract/index.js';
import { runtimeApi } from '../api.js';

export interface ProvidersState {
  readonly providers: ModelProviderRecord[] | null;
  readonly ready: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  /** Resolves false on failure (the message lands in `error`) so a form can stay open. */
  create(draft: CreateProviderRequest): Promise<boolean>;
  update(id: string, fields: UpdateProviderRequest): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  probe(id: string, model: string): Promise<ProbeResult | null>;
  discover(id: string): Promise<string[] | null>;
}

export function useProviders(): ProvidersState {
  const [providers, setProviders] = useState<ModelProviderRecord[] | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await runtimeApi.providers();
      setProviders(data.providers);
      setReady(data.ready);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useLive(load, (msg) => msg.t === 'runtime.changed');

  const guard = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      await load();
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    providers,
    ready,
    error,
    busy,
    create: (draft) => guard(() => runtimeApi.create(draft)),
    update: (id, fields) => guard(() => runtimeApi.update(id, fields)),
    remove: (id) => guard(() => runtimeApi.remove(id)),
    discover: async (id) => {
      setBusy(true);
      try {
        return (await runtimeApi.availableModels(id)).models;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    probe: async (id, model) => {
      setBusy(true);
      try {
        const { result } = await runtimeApi.probe(id, model);
        await load();
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
  };
}
