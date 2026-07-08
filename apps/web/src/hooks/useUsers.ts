import { useCallback, useState } from 'react';
import type { Role, UserRecord } from '@companion/contract';
import { api } from '../lib/api.js';
import { PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';

/**
 * User administration data: the debounced-search + role-filtered, server-paged
 * user list, plus an `act` helper that runs a mutation and reloads the list
 * (surfacing failures in `error`).
 */
export function useUsers(): {
  search: string;
  setSearch: (s: string) => void;
  role: 'all' | Role;
  setRole: (r: 'all' | Role) => void;
  users: UserRecord[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  error: string | null;
  listError: string | null;
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
} {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | Role>('all');
  const [error, setError] = useState<string | null>(null);

  const q = useDebounced(search.trim());
  const fetchPage = useCallback(
    async (offset: number) => {
      const { users, total } = await api.listUsers({
        q: q || undefined,
        role: role === 'all' ? undefined : role,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: users, total };
    },
    [q, role],
  );
  const { items: users, total, loading, hasMore, loadMore, reload, error: listError } = useInfiniteList(fetchPage);

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  return { search, setSearch, role, setRole, users, total, loading, hasMore, loadMore, reload, error, listError, act };
}
