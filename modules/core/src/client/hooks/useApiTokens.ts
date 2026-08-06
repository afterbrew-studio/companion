import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-core/client';
import type { Permission } from '@moxxy/companion-contracts';
import type {
  ApiTokenCapability,
  ApiTokenRecord,
  CreateApiTokenResponse,
} from '../../contract/index.js';
import { coreApi } from '../api.js';

export interface ApiTokensState {
  readonly mine: readonly ApiTokenRecord[] | null;
  readonly all: readonly ApiTokenRecord[];
  readonly total: number;
  readonly capabilities: readonly ApiTokenCapability[];
  readonly error: string | null;
  readonly busy: string | null;
  create(input: {
    readonly name: string;
    readonly permissions: readonly Permission[];
    readonly expiresInDays: number;
  }): Promise<CreateApiTokenResponse | null>;
  revoke(id: string, anyUser?: boolean): Promise<boolean>;
}

/** Personal and, when permitted, instance-wide API credentials kept live. */
export function useApiTokens(admin: boolean): ApiTokensState {
  const [mine, setMine] = useState<readonly ApiTokenRecord[] | null>(null);
  const [all, setAll] = useState<readonly ApiTokenRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [capabilities, setCapabilities] = useState<readonly ApiTokenCapability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [personal, instance] = await Promise.all([
        coreApi.listApiTokens(),
        admin ? coreApi.listAllApiTokens({ limit: 200 }) : Promise.resolve(null),
      ]);
      setMine(personal.tokens);
      setCapabilities(personal.capabilities);
      setAll(instance?.tokens ?? []);
      setTotal(instance?.total ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [admin]);
  useLive(refresh, (message) => message.t === 'tokens.changed');

  const create = async (input: {
    readonly name: string;
    readonly permissions: readonly Permission[];
    readonly expiresInDays: number;
  }): Promise<CreateApiTokenResponse | null> => {
    setBusy('create');
    setError(null);
    try {
      const created = await coreApi.createApiToken(input);
      await refresh();
      return created;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string, anyUser = false): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      await (anyUser ? coreApi.revokeAnyApiToken(id) : coreApi.revokeApiToken(id));
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { mine, all, total, capabilities, error, busy, create, revoke };
}
