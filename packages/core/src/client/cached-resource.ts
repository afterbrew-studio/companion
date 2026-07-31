import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthChanged } from './net.js';

/**
 * Stale-while-revalidate for read payloads the SPA fetches per page.
 *
 * The daemon is already the cache in front of GitHub, so a second visit to a
 * pull request is asking a local process for something it just answered. What
 * the user sees is a spinner anyway, because the component starts from `null`
 * every time it mounts. Keeping the last payload turns a revisit into an
 * instant render with a quiet refresh behind it.
 *
 * This is a render-time cache and nothing more: it never serves a mutation, and
 * every hit still revalidates. Anything that must be current on the frame it is
 * read (a merge decision, an approval) reads it from the revalidated payload,
 * not from the first paint.
 */

/**
 * Ceiling on retained payloads. A long session wanders across many pull
 * requests and issues, and each entry holds a whole response; without a bound
 * the tab's memory grows with navigation and never comes back.
 */
const MAX_ENTRIES = 60;

const cache = new Map<string, unknown>();

/**
 * A payload is scoped to whoever fetched it. Signing out (or in as someone
 * else) must not leave the previous session's pull requests on screen for the
 * next one, so the whole cache goes rather than being re-keyed by user.
 */
onAuthChanged(() => cache.clear());

/** The retained payload for a key, or null. For seeding a list's first page. */
export function readCached<T>(key: string): T | null {
  return (cache.get(key) as T) ?? null;
}

/** Retain a payload fetched outside {@link useCachedResource}. */
export function writeCached<T>(key: string, value: T): void {
  remember(key, value);
}

/** Drop a key, or everything, when a mutation makes the retained copy a lie. */
export function invalidateCached(key?: string): void {
  if (key === undefined) cache.clear();
  else cache.delete(key);
}

function remember(key: string, value: unknown): void {
  // Re-insert so the key moves to the young end: Map iterates in insertion
  // order, which makes the first key the least recently used one.
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface CachedResource<T> {
  /** The retained payload on the first frame, then the revalidated one. */
  readonly data: T | null;
  /**
   * True only when there is nothing to show yet. A revisit is never loading,
   * which is the whole point; use `revalidating` to show a quiet indicator.
   */
  readonly loading: boolean;
  readonly revalidating: boolean;
  readonly error: string | null;
  readonly setError: (e: string | null) => void;
  readonly refresh: () => Promise<void>;
  /** Write a locally-known payload through, e.g. right after a mutation. */
  readonly set: (next: T) => void;
}

/**
 * `key` identifies the payload; pass null to hold off entirely (no workspace
 * chosen yet). `load` must be stable — memoize it at the call site, as the
 * effect re-runs whenever it changes.
 */
export function useCachedResource<T>(key: string | null, load: () => Promise<T>): CachedResource<T> {
  const [data, setData] = useState<T | null>(() => (key === null ? null : ((cache.get(key) as T) ?? null)));
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Navigating away mid-flight must not write the previous page's payload into
  // the one now on screen.
  const liveKey = useRef(key);

  useEffect(() => {
    liveKey.current = key;
    setData(key === null ? null : ((cache.get(key) as T) ?? null));
    setError(null);
  }, [key]);

  const refresh = useCallback(async (): Promise<void> => {
    if (key === null) return;
    setRevalidating(true);
    try {
      const next = await load();
      if (liveKey.current !== key) return;
      remember(key, next);
      setData(next);
      setError(null);
    } catch (err) {
      if (liveKey.current !== key) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (liveKey.current === key) setRevalidating(false);
    }
  }, [key, load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const set = useCallback(
    (next: T) => {
      if (key !== null) remember(key, next);
      setData(next);
    },
    [key],
  );

  return {
    data,
    loading: data === null && error === null,
    revalidating,
    error,
    setError,
    refresh,
    set,
  };
}
