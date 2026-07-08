import { useHashParams } from '../lib/hashParams.js';

export interface HashFilters<K extends string> {
  /** Each key's value, defaulting to 'all' when the param is absent. */
  readonly filters: Record<K, string>;
  readonly setFilter: (key: string) => (value: string) => void;
  readonly clearFilters: () => void;
  /** How many filters are set to something other than 'all'. */
  readonly activeFilters: number;
}

/**
 * A set of 'all'-defaulted list filters synced to the hash query. One concern;
 * the state lives in the hash. Reused by any server-paged list with filters.
 */
export function useHashFilters<K extends string>(keys: readonly K[]): HashFilters<K> {
  const [params, setParam] = useHashParams();
  const filters = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? 'all'])) as Record<K, string>;
  return {
    filters,
    setFilter: (key) => (value) => setParam(key, value === 'all' ? null : value),
    clearFilters: () => {
      for (const k of keys) setParam(k, null);
    },
    activeFilters: keys.filter((k) => filters[k] !== 'all').length,
  };
}
