import { useEffect } from 'react';
import { useHashParams } from '../lib/hashParams.js';

/**
 * A list's active tab, synced to the ?state= hash param (so a filtered view is
 * a shareable URL) and remembered per `storageKey` for breadcrumb returns. One
 * concern; the state lives in the hash, not React.
 */
export function useHashTab<T extends string>(values: readonly T[], fallback: T, storageKey: string): [T, (t: T) => void] {
  const [params, setParam] = useHashParams();
  const raw = params.get('state');
  const tab = (values as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  useEffect(() => {
    sessionStorage.setItem(storageKey, tab);
  }, [storageKey, tab]);
  const setTab = (t: T): void => setParam('state', t === fallback ? null : t);
  return [tab, setTab];
}
